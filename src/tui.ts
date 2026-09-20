/**
 * 交互式 TUI:会话看板 + 分屏面板
 *   渲染 tui-view.ts/tui-layout.ts · 屏幕与挂起 tui-screen.ts · 按键 keys.ts/tui-keys.ts/tui-context.ts
 *   分屏引擎 panes.ts(可选依赖 tui-panes)· 整屏接管 tui-attach.ts
 */

import type { SessionView } from "./model.ts";
import { copyResumeCommand, focusSession } from "./actions.ts";
import { parseKeys } from "./keys.ts";
import { dispatchKey, type ActionKind } from "./tui-keys.ts";
import { createContext } from "./tui-context.ts";
import { createTuiScreen } from "./tui-screen.ts";
import { createLazyPanes } from "./panes.ts";
import { runAttach } from "./tui-attach.ts";
import { filterRows, layoutMetrics, renderScreen, stripAnsi, totalsOf, type FilterKind, type TuiState } from "./tui-view.ts";

const REFRESH_MS = 3000;
const ESCAPE_WAIT_MS = 40;
const REDRAW_THROTTLE_MS = 80;

export interface TuiOptions {
	load: () => Promise<SessionView[]>;
	filter?: FilterKind;
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
	let inputBuffer = "";
	let escapeTimer: ReturnType<typeof setTimeout> | null = null;
	let drawTimer: ReturnType<typeof setTimeout> | null = null;
	let done: () => void = () => {};

	const computeState = (): TuiState => {
		const rows = filterRows(allRows, ui.filter, ui.query);
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
			refreshedAt: new Date(),
			now: new Date(),
			panes: panesLazy.current()?.snapshots(),
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
		onData: (chunk) => handleChunk(chunk),
		onResize: () => {
			panesLazy.current()?.syncSize();
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

	/** 分屏引擎:tui-panes 为可选依赖,首次使用时才导入 */
	const panesLazy = createLazyPanes(
		{
			selected,
			metrics: () => {
				const metrics = layoutMetrics(computeState());
				return { rightWidth: metrics.rightWidth, bodyHeight: metrics.bodyHeight };
			},
			redraw: () => draw(true),
			schedule: scheduleDraw,
			notify: (text) => (message = text),
		},
		(text) => {
			message = text;
			draw(true);
		},
		() => draw(true),
	);

	const attach = (view: SessionView): Promise<void> =>
		runAttach(screen, view, { reload, notify: (text) => (message = text), redraw: () => draw(true) });

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
			// 历史会话:默认在分屏里打开(不占整屏,可同时看多个)
			const engine = await panesLazy.ensure();
			if (!engine) return;
			return engine.open();
		}
		draw(true);
	};

	const move = (delta: number): void => {
		const total = computeState().rows.length;
		ui.cursor = Math.max(0, Math.min(total - 1, computeState().cursor + delta));
		draw(true);
	};

	const context = createContext({
		ui,
		rowCount: () => computeState().rows.length,
		move,
		act,
		panes: {
			open: () => panesLazy.withPanes((engine) => engine.open()),
			cycle: () => panesLazy.withPanes((engine) => engine.cycle()),
			close: () => panesLazy.withPanes((engine) => engine.close()),
		},
		refresh: async () => {
			message = "手动刷新…";
			await reload();
			draw(true);
		},
		quit: () => done(),
		redraw: () => draw(true),
	});

	/** 按键分片安全:未完成的转义序列先缓冲,单独的 ESC 短暂等待后按退出处理 */
	function handleChunk(chunk: Buffer): void {
		// 面板聚焦时,按键直接转发给该会话(仅保留 Ctrl+Q/Ctrl+W 两个逃生键)
		if (panesLazy.current()?.handleFocusedInput(chunk.toString("utf8"))) return;
		inputBuffer += chunk.toString("utf8");
		const { keys, rest } = parseKeys(inputBuffer);
		inputBuffer = rest;
		for (const key of keys) void dispatchKey(key, context);
		if (inputBuffer && !escapeTimer) {
			escapeTimer = setTimeout(() => {
				escapeTimer = null;
				const pending = inputBuffer;
				inputBuffer = "";
				for (const key of parseKeys(pending).keys) void dispatchKey(key, context);
			}, ESCAPE_WAIT_MS);
		}
	}

	screen.enter();
	await reload();
	draw(true);
	screen.startTicker(() => {
		void reload().then(() => draw());
	}, REFRESH_MS);

	await new Promise<void>((resolve) => {
		done = (): void => {
			if (escapeTimer) clearTimeout(escapeTimer);
			if (drawTimer) clearTimeout(drawTimer);
			panesLazy.current()?.dispose();
			screen.leave(message || "已退出");
			resolve();
		};
	});
}
