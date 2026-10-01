/**
 * 交互式 TUI:核心=会话总览,同页分屏等能力由拓展提供(src/extensions.ts)。
 * 渲染 tui-view.ts/tui-layout.ts · 屏幕 tui-screen.ts · 按键 keys/tui-keys/tui-context
 */

import type { SessionView } from "./model.ts";
import { clearCache } from "./cache.ts";
import { resumeCommand } from "./actions.ts";
import { createInputPump } from "./tui-input.ts";
import { createContext } from "./tui-context.ts";
import { createTuiScreen } from "./tui-screen.ts";
import { createDeleteFlow } from "./tui-delete.ts";
import { createTuiActions } from "./tui-actions.ts";
import { supportsColor } from "./theme.ts";
import { loadExtensions, type ExtensionContext, type HubExtension } from "./extensions.ts";
import { createExtensionContext } from "./tui-extension-ctx.ts";
import { buildTuiState, renderScreen, stripAnsi, type FilterKind, type TuiState } from "./tui-view.ts";
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
	let done: (why: string) => void = () => {};
	/** 已加载的拓展(加载失败只提示,不影响核心) */
	const loaded = await loadExtensions(options.extensions);
	const extensions: HubExtension[] = loaded.filter((entry) => !entry.error).map((entry) => entry.extension);
	const failures = loaded.filter((entry) => entry.error);

	const computeState = (): TuiState =>
		buildTuiState({
			allRows,
			filter: ui.filter,
			query: ui.query,
			searchMode: ui.searchMode,
			cursor: ui.cursor,
			width: stdout.columns ?? 120,
			height: stdout.rows ?? 30,
			message,
			confirm: deleteFlow.pending(),
			color: supportsColor(process.env, Boolean(stdout.isTTY)),
			customBody: extensions.map((extension) => extension.bodyView?.(extCtx)).find((value) => value && value.length),
			customHints: extensions.flatMap((extension) => extension.hints ?? []),
		});

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

	const actions = createTuiActions({
		rows: () => computeState().rows,
		cursorIndex: () => ui.cursor,
		setCursorIndex: (index) => {
			ui.cursor = index;
		},
		screen,
		reload,
		notify: (text) => {
			message = text;
		},
		redraw: () => draw(true),
		extensions,
		extensionContext: () => extCtx,
	});

	const extCtx: ExtensionContext = createExtensionContext({
		selected: actions.selected,
		size: () => ({ width: stdout.columns ?? 120, height: stdout.rows ?? 30 }),
		notify: (text) => (message = text),
		redraw: () => draw(true),
		schedule: () => scheduleDraw(),
	});

	const deleteFlow = createDeleteFlow({
		rows: () => allRows,
		selected: actions.selected,
		notify: (text) => (message = text),
		redraw: () => draw(true),
		reload,
	});

	const context = createContext({
		ui,
		rowCount: () => computeState().rows.length,
		move: actions.move,
		act: actions.act,
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
			message = "强制刷新中(清缓存)…";
			try {
				await clearCache();
			} catch {
				/* 清缓存失败不阻塞刷新 */
			}
			await reload();
			draw(true);
		},
		quit: (why) => done(why),
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
		done = (why: string): void => {
			input.dispose();
			if (drawTimer) clearTimeout(drawTimer);
			for (const extension of extensions) extension.dispose?.();
			screen.leave(message || `已退出(${why})`);
			resolve();
		};
	});
}
