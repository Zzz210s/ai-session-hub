/**
 * TUI 按键分发(纯逻辑,可单测):按键名 → 对上下文的一组操作
 */

import type { KeyName } from "./keys.ts";
import type { FilterKind } from "./tui-view.ts";

export type ActionKind = "smart" | "attach" | "focus" | "copy";

/**
 * 拓展键钩子:核心只负责把按键交给拓展(如 tui-panes 的分屏),不关心其语义。
 * 返回 true 表示该按键已由拓展消费。
 */
export interface ExtensionKeys {
	handle(key: KeyName): boolean | Promise<boolean>;
	/** 底部提示片段(拓展自己声明) */
	hints(): string[];
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
	/** 拓展按键入口(可无) */
	extensions?: ExtensionKeys;
	/** 待确认操作(如删除会话):返回提示文案或 undefined */
	pendingConfirm?(): string | undefined;
	/** 请求删除选中会话(进入确认态) */
	requestDelete(): void;
	/** 确认/取消待确认操作 */
	answerConfirm(accepted: boolean): void;
	refresh(): void | Promise<void>;
	quit(): void;
	redraw(): void;
}

const FILTERS: FilterKind[] = ["running", "attention", "all", "stored"];

export async function dispatchKey(key: KeyName, ctx: KeyContext): Promise<void> {
	// 待确认的破坏性操作优先:只接受 y / n / Esc
	if (ctx.pendingConfirm?.()) {
		const ch = typeof key === "object" ? key.char : undefined;
		if (ch === "y" || ch === "Y") {
			ctx.answerConfirm(true);
			return;
		}
		if (ch === "n" || ch === "N" || key === "escape" || key === "quit") {
			ctx.answerConfirm(false);
			return;
		}
		return;
	}
	if (ctx.extensions && (await ctx.extensions.handle(key))) return;
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
		if (ch === "d") return ctx.requestDelete();
		if (ch === "j") {
			ctx.move(1);
			return;
		}
		if (ch === "k") {
			ctx.move(-1);
			return;
		}
		if (ch === "r") return void ctx.refresh();
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
