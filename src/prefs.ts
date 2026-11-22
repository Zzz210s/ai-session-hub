/**
 * 界面偏好的持久化:`~/.ai-session-hub/config.json` 的 `ui` 段。
 *
 * 只放"按一次键就该记住"的东西(当前是排序方式)。打开会话的配置在 open-config.ts
 * (同一份文件、不同的段),两边各读各的,互不覆盖 —— 写回时都是"读全文 → 改自己那段 → 写回",
 * 所以只要不改别人的键就不会踩到彼此。
 *
 * 所有读写都吞异常:偏好丢了只是体验差一点,不该让看板起不来。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asSortMode, type SortMode } from "./sort.ts";

export function prefsPath(home: string = homedir()): string {
	return join(home, ".ai-session-hub", "config.json");
}

/** 读排序偏好(缺失/损坏 = 默认顺序) */
export function readSortMode(path: string = prefsPath()): SortMode {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { ui?: { sort?: unknown } } | null;
		return asSortMode(raw?.ui?.sort) ?? "default";
	} catch {
		return "default";
	}
}

/**
 * 写排序偏好(保留文件里其它键)。
 *
 * 用 2 空格缩进写回,与仓库文档里给的示例一致;文件是纯 JSON、没有注释,
 * 重新序列化不会丢掉用户写的东西。
 */
export function writeSortMode(mode: SortMode, path: string = prefsPath()): void {
	try {
		let raw: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
		} catch {
			// 文件不存在或不是合法 JSON:从空对象开始,别把用户原来的内容带坏
		}
		const ui = raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? (raw.ui as Record<string, unknown>) : {};
		raw.ui = { ...ui, sort: mode };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	} catch {
		// 只读目录/权限不足:按一次键没记住而已,提示交给调用方
	}
}
