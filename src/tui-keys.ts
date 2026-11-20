/**
 * TUI 按键分发(纯逻辑,可单测):按键名 → 对上下文的一组操作
 */

import type { KeyName } from "./keys.ts";
import type { FilterKind } from "./tui-view.ts";

export type ActionKind = "smart" | "attach" | "attach-inplace" | "focus" | "copy";

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
	/** 当前搜索词长度(用于"删空后再按一次退出搜索") */
	queryLength(): number;
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
	/** 退出;why 用于退出时告知原因(q / ctrl-c / escape) */
	quit(why: string): void;
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
			// 搜索词**区分**大小写(用户可能就是要找 "AIS")
			if (ch >= " ") {
				ctx.appendQuery(ch);
				ctx.redraw();
			}
			return;
		}
		// 快捷键不区分大小写(2026-11-19 用户要求):`A` 等同 `a`,`Q` 等同 `q` ——
		// 开了 CapsLock 或习惯按住 Shift 时不该变成"按键没反应"
		const hot = ch.toLowerCase();
		if (hot === "q") return ctx.quit("q");
		if (ch === "/") {
			ctx.setSearching(true);
			ctx.redraw();
			return;
		}
		if (hot === "a") return void ctx.act("attach");
		if (hot === "f") return void ctx.act("focus");
		if (hot === "c") return void ctx.act("copy");
		if (hot === "d") return ctx.requestDelete();
		if (hot === "j") {
			ctx.move(1);
			return;
		}
		if (hot === "k") {
			ctx.move(-1);
			return;
		}
		if (hot === "r") return void ctx.refresh();
		const digit = "1234".indexOf(ch);
		if (digit >= 0) {
			ctx.setFilter(FILTERS[digit]);
			ctx.redraw();
		}
		return;
	}

	// 功能键
	switch (key) {
		case "ctrl-a":
			// 就地接管:2026-11-19 从字母 A 改为 Ctrl+A(大写键容易误触,也不适合当"接管终端")。
			// 搜索态不接管:那里 Ctrl+A 通常是"行首",直接把终端交出去会让人莫名其妙
			if (ctx.isSearching()) return;
			return void ctx.act("attach-inplace");
		case "quit":
			return ctx.quit("ctrl-c");
		case "escape":
			if (ctx.isSearching()) {
				ctx.setSearching(false);
				ctx.clearQuery();
				ctx.redraw();
				return;
			}
			return ctx.quit("escape");
		case "enter":
			if (ctx.isSearching()) {
				ctx.setSearching(false);
				ctx.redraw();
				return;
			}
			return void ctx.act("smart");
		case "backspace":
			if (ctx.isSearching()) {
				// 已经删空:再按一次就退出搜索(不用非得去按 Esc)
				if (ctx.queryLength() === 0) {
					ctx.setSearching(false);
					ctx.redraw();
					return;
				}
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
