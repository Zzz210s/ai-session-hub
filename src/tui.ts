/**
 * 交互式 TUI:核心=会话总览,同页分屏等能力由拓展提供(src/extensions.ts)。
 * 渲染 tui-view.ts/tui-layout.ts · 屏幕 tui-screen.ts · 按键 keys/tui-keys/tui-context
 */

import type { SessionView } from "./model.ts";
import { copyResumeCommand, focusSession, resumeCommand } from "./actions.ts";
import { type ActionKind } from "./tui-keys.ts";
import { createInputPump } from "./tui-input.ts";
import { createContext } from "./tui-context.ts";
import { createTuiScreen } from "./tui-screen.ts";
import { runAttach } from "./tui-attach.ts";
import { createDeleteFlow } from "./tui-delete.ts";
import { supportsColor } from "./theme.ts";
import { loadExtensions, type ExtensionContext, type HubExtension } from "./extensions.ts";
import { createExtensionContext } from "./tui-extension-ctx.ts";
import { filterRows, renderScreen, stripAnsi, totalsOf, type FilterKind, type TuiState } from "./tui-view.ts";
import { fullTitle } from "./format.ts";

const REFRESH_MS = 3000;
const REDRAW_THROTTLE_MS = 80;

export interface TuiOptions {
	load: (options?: { liveTtlMs?: number }) => Promise<SessionView[]>;
	filter?: FilterKind;
	/** 要加载的拓展(默认:环境变量/配置文件/内置默认列表) */
	extensions?: string[];
}

export async function runTui(options: TuiOptions): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("需要交互式终端;非 TTY 下请用 `ais list`");
	}

	const stdin = process.stdin;
	const stdout = process.stdout;
	const ui = { filter: options.filter ?? "all", query: "", searchMode: false, cursor: 0 };
	let allRows: SessionView[] = [];
	let message = "";
	let drawTimer: ReturnType<typeof setTimeout> | null = null;
	let done: () => void = () => {};

	/** 已加载的拓展(加载失败只提示,不影响核心) */
	const loaded = await loadExtensions(options.extensions);
	const extensions: HubExtension[] = loaded.filter((entry) => !entry.error).map((entry) => entry.extension);
	const failures = loaded.filter((entry) => entry.error);

	const computeState = (): TuiState => {
		const rows = filterRows(allRows, ui.filter, ui.query);
		const body = extensions.map((extension) => extension.bodyView?.(extCtx)).find((value) => value && value.length);
		const hints = extensions.flatMap((extension) => extension.hints ?? []);
		return {
			rows,
			totals: totalsOf(allRows),
			filter: ui.filter,
			query: ui.query,
			searchMode: ui.searchMode,
			cursor: Math.min(ui.cursor, Math.max(0, rows.length - 1)),
			width: stdout.columns ?? 120,
			height: stdout.rows ?? 30,
			message,
			confirm: deleteFlow.pending(),
			refreshedAt: new Date(),
			now: new Date(),
			color: supportsColor(process.env, Boolean(stdout.isTTY)),
			customBody: body,
			customHints: hints.length ? hints : undefined,
		};
	};

	const draw = (force = false): void => {
		const state = computeState();
		const lines = renderScreen(state);
		screen.draw(lines, `${state.width}x${state.height}|${lines.map(stripAnsi).join("\n")}`, force);
	};

	const scheduleDraw = (): void => {
		if (drawTimer || screen.suspended) return;
		drawTimer = setTimeout(() => {
			drawTimer = null;
			draw(true);
		}, REDRAW_THROTTLE_MS);
	};

	const screen = createTuiScreen({
		stdin,
		stdout,
		onData: (chunk) => input.feed(chunk),
		onResize: () => {
			for (const extension of extensions) extension.onResize?.(extCtx);
			draw(true);
		},
	});

	const reload = async (): Promise<void> => {
		try {
			allRows = await options.load();
		} catch (error) {
			message = `刷新失败: ${error instanceof Error ? error.message : String(error)}`;
		}
	};

	const selected = (): SessionView | undefined => {
		const state = computeState();
		return state.rows[state.cursor];
	};

	const attach = (view: SessionView): Promise<void> => runAttach(screen, view, { reload, notify: extCtx.notify, redraw: extCtx.redraw });

	const act = async (kind: ActionKind): Promise<void> => {
		const view = selected();
		if (!view) return;
		if (kind === "attach") return attach(view);
		if (kind === "copy") {
			message = (await copyResumeCommand(view)).detail;
		} else if (kind === "focus") {
			message = (await focusSession(view)).detail;
		} else if (view.state === "running" && view.live?.tab) {
			message = (await focusSession(view)).detail;
		} else {
			// 历史会话:交给拓展(如分屏)打开;没有拓展时提示可用 a 接管
			const opener = extensions.find((extension) => extension.openSelected);
			if (opener?.openSelected) await opener.openSelected(extCtx);
			else message = "该会话未运行:按 a 接管终端继续";
		}
		draw(true);
	};

	const move = (delta: number): void => {
		ui.cursor = Math.max(0, Math.min(computeState().rows.length - 1, computeState().cursor + delta));
		draw(true);
	};

	/** 传给拓展的上下文(会话信息含恢复命令 + 尺寸 + 提示/重绘) */
	const extCtx: ExtensionContext = createExtensionContext({
		selected,
		size: () => ({ width: stdout.columns ?? 120, height: stdout.rows ?? 30 }),
		notify: (text) => (message = text),
		redraw: () => draw(true),
		schedule: () => scheduleDraw(),
	});

	const deleteFlow = createDeleteFlow({
		rows: () => allRows,
		selected,
		notify: (text) => (message = text),
		redraw: () => draw(true),
		reload,
	});

	const context = createContext({
		ui,
		rowCount: () => computeState().rows.length,
		move,
		act,
		pendingConfirm: () => deleteFlow.pending(),
		requestDelete: () => deleteFlow.request(),
		answerConfirm: (accepted) => deleteFlow.answer(accepted),
		extensions: {
			handle: async (key: KeyName) => {
				for (const extension of extensions) if (await extension.handleKey?.(key, extCtx)) return true;
				return false;
			},
			hints: () => extensions.flatMap((extension) => extension.hints ?? []),
		},
		refresh: async () => {
			message = "手动刷新…";
			await reload();
			draw(true);
		},
		quit: () => done(),
		redraw: () => draw(true),
	});

	const input = createInputPump({
		ctx: context,
		// 拓展优先处理原始输入(分屏聚焦时按键直达会话)
		extensionHandled: (text) => extensions.some((extension) => extension.handleRawInput?.(text, extCtx) === true),
	});

	screen.enter();
	// 先画一帧(立即有界面),再去加载 —— 冷缓存时探测/扫描要几秒,不该让用户盯着空白
	message = "正在探测会话…";
	draw(true);
	await reload();
	if (failures.length) message = `拓展加载失败: ${failures.map((entry) => `${entry.name}(${entry.error})`).join("; ")}`;
	else if (message === "正在探测会话…") message = "";
	draw(true);
	screen.startTicker(() => {
		void reload().then(() => draw());
	}, REFRESH_MS);

	await new Promise<void>((resolve) => {
		done = (): void => {
			input.dispose();
			if (drawTimer) clearTimeout(drawTimer);
			for (const extension of extensions) extension.dispose?.();
			screen.leave(message || "已退出");
			resolve();
		};
	});
}
