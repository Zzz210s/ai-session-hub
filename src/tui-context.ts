/**
 * 按键上下文:把 TUI 的可变状态与动作封装成 dispatchKey 需要的接口
 * 抽出的目的:让 tui.ts 只负责 I/O 与生命周期。
 */

import type { FilterKind } from "./tui-view.ts";
import type { ActionKind, ExtensionKeys, KeyContext } from "./tui-keys.ts";

export interface UiState {
	filter: FilterKind;
	query: string;
	searchMode: boolean;
	cursor: number;
}

export interface ContextDeps {
	ui: UiState;
	/** 当前过滤后的行数 */
	rowCount(): number;
	move(delta: number): void;
	act(kind: ActionKind): void | Promise<void>;
	refresh(): void | Promise<void>;
	quit(): void;
	redraw(): void;
	extensions?: ExtensionKeys;
}

export function createContext(deps: ContextDeps): KeyContext {
	const { ui } = deps;
	return {
		isSearching: () => ui.searchMode,
		setSearching: (value) => {
			ui.searchMode = value;
		},
		appendQuery: (char) => {
			ui.query += char;
			ui.cursor = 0;
		},
		backspaceQuery: () => {
			ui.query = ui.query.slice(0, -1);
			ui.cursor = 0;
		},
		clearQuery: () => {
			ui.query = "";
			ui.cursor = 0;
		},
		move: deps.move,
		jumpTo: (position) => {
			ui.cursor = position === "top" ? 0 : Math.max(0, deps.rowCount() - 1);
			deps.redraw();
		},
		setFilter: (kind) => {
			ui.filter = kind;
			ui.cursor = 0;
		},
		act: deps.act,
		extensions: deps.extensions,
		refresh: deps.refresh,
		quit: deps.quit,
		redraw: deps.redraw,
	};
}
