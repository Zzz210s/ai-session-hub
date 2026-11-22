/**
 * TUI 的动作装配:把"拓展按键适配 / 强制刷新 / 排序切换"这三块从 tui.ts 里搬出来。
 *
 * 搬的理由不是行数洁癖:tui.ts 只管 I/O 与生命周期(进屏、泵输入、定时重绘、退出),
 * 而这三块都是"按键 → 状态改动 + 提示 + 重绘"的纯装配,能单独测、也不会碰终端。
 */

import type { HubExtension } from "./extensions.ts";
import type { SortMode } from "./sort.ts";
import { nextSortMode, SORT_LABELS } from "./sort.ts";
import { writeSortMode } from "./prefs.ts";
import type { ExtensionKeys, KeyName } from "./tui-keys.ts";

/** 把拓展适配成 dispatchKey 需要的 ExtensionKeys(拓展优先处理按键) */
export function createExtensionKeys(extensions: HubExtension[], extCtx: unknown): ExtensionKeys {
	return {
		handle: async (key: KeyName) => {
			for (const extension of extensions) if (await extension.handleKey?.(key, extCtx as never)) return true;
			return false;
		},
		hints: () => extensions.flatMap((extension) => extension.hints ?? []),
	};
}

/** `r` 键:清缓存 + 重扫 + 重绘(清缓存失败不阻塞刷新) */
export function createRefreshAction(deps: {
	clear(): Promise<void>;
	reload(): Promise<void>;
	notify(message: string): void;
	redraw(): void;
}): () => Promise<void> {
	return async () => {
		deps.notify("强制刷新中(清缓存)…");
		try {
			await deps.clear();
		} catch {
			/* 清缓存失败不阻塞刷新 */
		}
		await deps.reload();
		deps.redraw();
	};
}

/**
 * `s` 键:循环切换排序(默认 → 字母 → 默认)。
 *
 * 切换后**光标回到顶部**:顺序变了还停在原来那一条上,会让人以为自己看错了列表。
 * 选择会写进 `~/.ai-session-hub/config.json` 的 `ui.sort`,下次启动仍是这个顺序。
 */
export function createSortToggle(deps: {
	get(): SortMode;
	set(mode: SortMode): void;
	resetCursor(): void;
	notify(message: string): void;
	redraw(): void;
	persist?(mode: SortMode): void;
}): () => void {
	return () => {
		const mode = nextSortMode(deps.get());
		deps.set(mode);
		deps.resetCursor();
		(deps.persist ?? writeSortMode)(mode);
		deps.notify(`排序:${SORT_LABELS[mode]}`);
		deps.redraw();
	};
}
