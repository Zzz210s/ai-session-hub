/**
 * TUI 按键分发(纯逻辑,可单测):按键名 → 对上下文的一组操作
 */

import type { KeyName } from "./keys.ts";
import type { FilterKind } from "./tui-view.ts";

export type ActionKind = "smart" | "attach" | "focus" | "copy";

/** 分屏相关操作(由 TUI 注入) */
export interface PaneOps {
	open(): void | Promise<void>;
	cycle(): void;
	close(): void;
}

export interface KeyContext {
	isSearching(): boolean;
	setSearching(value: boolean): void;
	appendQuery(char: string): void;
	backspaceQuery(): void;
	clearQuery(): void;
	move(delta: number): void;
	jumpTo(position: "top" | "bottom"): void;
	setFilter(kind: FilterKind): void;
	act(kind: ActionKind): void | Promise<void>;
	/** 分屏操作(未启用分屏时可传空实现) */
	panes: PaneOps;
	refresh(): void | Promise<void>;
	quit(): void;
	redraw(): void;
}

const FILTERS: FilterKind[] = ["running", "attention", "all", "stored"];

export async function dispatchKey(key: KeyName, ctx: KeyContext): Promise<void> {
	// 字符键
	if (typeof key === "object") {
		const ch = key.char;
		if (ctx.isSearching()) {
			if (ch >= " ") {
				ctx.appendQuery(ch);
				ctx.redraw();
			}
			return;
		}
		if (ch === "q") return ctx.quit();
		if (ch === "/") {
			ctx.setSearching(true);
			ctx.redraw();
			return;
		}
		if (ch === "a") return void ctx.act("attach");
		if (ch === "f") return void ctx.act("focus");
		if (ch === "c") return void ctx.act("copy");
		if (ch === "j") {
			ctx.move(1);
			return;
		}
		if (ch === "k") {
			ctx.move(-1);
			return;
		}
		if (ch === "r") return void ctx.refresh();
		if (ch === "p") return void ctx.panes.open();
		if (ch === "x") return ctx.panes.close();
		if (ch === "	") {
			ctx.panes.cycle();
			return;
		}
		const digit = "1234".indexOf(ch);
		if (digit >= 0) {
			ctx.setFilter(FILTERS[digit]);
			ctx.redraw();
		}
		return;
	}

	// 功能键
	switch (key) {
		case "quit":
			return ctx.quit();
		case "escape":
			if (ctx.isSearching()) {
				ctx.setSearching(false);
				ctx.clearQuery();
				ctx.redraw();
				return;
			}
			return ctx.quit();
		case "enter":
			if (ctx.isSearching()) {
				ctx.setSearching(false);
				ctx.redraw();
				return;
			}
			return void ctx.act("smart");
		case "backspace":
			if (ctx.isSearching()) {
				ctx.backspaceQuery();
				ctx.redraw();
			}
			return;
		case "up":
			ctx.move(-1);
			return;
		case "down":
			ctx.move(1);
			return;
		case "pageup":
			ctx.move(-10);
			return;
		case "pagedown":
			ctx.move(10);
			return;
		case "home":
			ctx.jumpTo("top");
			return;
		case "end":
			ctx.jumpTo("bottom");
			return;
		default:
			return;
	}
}
