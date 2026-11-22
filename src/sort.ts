/**
 * 列表排序(纯函数)。
 *
 * 只有两种,差别在"用户想按什么找会话":
 *   - `default`:运行中优先,其次最近活跃(scan/correlate.ts 出来的顺序,原样返回)
 *   - `alpha`  :按会话名的字母序 —— 知道名字、想快速定位时用(默认顺序下,
 *                一周前的会话会被几十条新会话挤到很后面)
 *
 * 字母序用 `localeCompare` 而不是 `<`:中文按拼音排(ICU 排序),
 * 数字按大小排(`会话 2` 在 `会话 10` 前面),大小写与全半角不敏感。
 *
 * 分组顺序跟 Windows 资源管理器一致:**数字 → 拉丁字母 → 中文 → 其它**。
 * 只用 ICU 的默认顺序会得到"中文全部排在拉丁之前",和资源管理器里差得很远
 * (实测冷启动列表里 `ais` 会掉到最后一条),所以先按首字符分组、组内再比。
 */

import type { SessionView } from "./model.ts";

export type SortMode = "default" | "alpha";

export const SORT_MODES: SortMode[] = ["default", "alpha"];

/** 顺序即按键循环顺序;文案用于状态行 */
export const SORT_LABELS: Record<SortMode, string> = {
	default: "运行日期",
	alpha: "字母",
};

export function asSortMode(value: unknown): SortMode | undefined {
	return value === "alpha" || value === "default" ? value : undefined;
}

/** 循环切换:`s` 键调用 */
export function nextSortMode(mode: SortMode): SortMode {
	const index = SORT_MODES.indexOf(mode);
	return SORT_MODES[(index + 1) % SORT_MODES.length]!;
}

/** 排序用的展示名:与行里显示的一致(name 优先,退回 topic,最后退回 id 前缀) */
export function sortName(row: SessionView): string {
	return row.name?.trim() || row.topic?.trim() || row.id.slice(0, 8);
}

const collator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });

/** 首字符分组:数字 0 / 拉丁 1 / 中文 2 / 其它 3(与资源管理器口径一致) */
export function sortBucket(text: string): number {
	const first = text.trimStart().charCodeAt(0);
	if (Number.isNaN(first)) return 3;
	if (first >= 0x30 && first <= 0x39) return 0; // 0-9
	if ((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a)) return 1; // A-Z a-z
	if (first >= 0x2e80) return 2; // CJK 及以后(含全角、假名)
	return 3;
}

export function sortRows(rows: SessionView[], mode: SortMode): SessionView[] {
	if (mode !== "alpha") return rows; // 默认顺序已由 correlate.ts 排好,原样返回(不复制)
	return [...rows].sort((a, b) => {
		const nameA = sortName(a);
		const nameB = sortName(b);
		const bucketA = sortBucket(nameA);
		const bucketB = sortBucket(nameB);
		if (bucketA !== bucketB) return bucketA - bucketB;
		const byName = collator.compare(nameA, nameB);
		if (byName !== 0) return byName;
		// 同名(不同工具里都叫"会话"很常见)按工具、再按最近活跃,保证顺序稳定
		if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
		return b.updatedAt.getTime() - a.updatedAt.getTime();
	});
}
