/**
 * 分屏适配层:把 ai-session-hub 的会话模型接到 tui-panes 引擎
 * tui-panes 是可选依赖(只影响分屏功能),缺失时给出安装提示。
 */

import type { SessionView } from "./model.ts";
import { resumeCommand } from "./actions.ts";

export interface PaneSpecLike {
	id: string;
	title: string;
	command: string;
	cwd?: string;
}

export interface PaneSnapshots {
	title: string;
	focused: boolean;
	lines: string[];
}

/** 宿主能力(由 TUI 注入) */
export interface PanesHost {
	selected(): SessionView | undefined;
	metrics(): { rightWidth: number; bodyHeight: number };
	redraw(): void;
	schedule(): void;
	notify(message: string): void;
}

/** 会话 → 面板规格(命令即恢复命令,由本进程托管 PTY) */
export function specFor(view: SessionView): PaneSpecLike {
	return {
		id: view.id,
		title: view.name?.trim() || view.topic?.trim() || view.id.slice(0, 8),
		command: resumeCommand(view),
		cwd: view.cwd || undefined,
	};
}

export interface Panes {
	open(): Promise<void>;
	close(): void;
	cycle(): void;
	handleFocusedInput(text: string): boolean;
	syncSize(): void;
	dispose(): void;
	snapshots(): PaneSnapshots[] | undefined;
}

/**
 * 创建分屏接入;动态导入 tui-panes,失败时抛出具可读原因的异常
 * (调用方展示给用户,提示安装方式)
 */
export async function createPanes(host: PanesHost): Promise<Panes> {
	let module: typeof import("tui-panes");
	try {
		module = await import("tui-panes");
	} catch (error) {
		throw new Error(`未安装 tui-panes(分屏引擎);执行 npm install 即可启用。${error instanceof Error ? error.message : ""}`);
	}
	const integration = module.createPaneIntegration({
		selectedSpec: () => {
			const view = host.selected();
			return view ? specFor(view) : undefined;
		},
		metrics: host.metrics,
		redraw: host.redraw,
		schedule: host.schedule,
		notify: host.notify,
	});
	return {
		open: () => integration.open(),
		close: () => integration.close(),
		cycle: () => integration.cycle(),
		handleFocusedInput: (text) => integration.handleFocusedInput(text),
		syncSize: () => integration.syncSize(),
		dispose: () => integration.dispose(),
		snapshots: () => integration.snapshots(),
	};
}

/** 惰性分屏接入:首次使用才导入 tui-panes,失败时把原因交回宿主提示 */
export interface LazyPanes {
	ensure(): Promise<Panes | null>;
	withPanes(run: (engine: Panes) => void | Promise<void>): void;
	current(): Panes | null;
}

export function createLazyPanes(host: PanesHost, onError: (message: string) => void, onReady: () => void): LazyPanes {
	let panes: Panes | null = null;
	const ensure = async (): Promise<Panes | null> => {
		if (panes) return panes;
		try {
			panes = await createPanes(host);
			onReady();
			return panes;
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
			return null;
		}
	};
	return {
		ensure,
		withPanes: (run) => void ensure().then((engine) => (engine ? run(engine) : undefined)),
		current: () => panes,
	};
}
