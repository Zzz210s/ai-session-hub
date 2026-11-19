/**
 * 已删会话的"墓碑":按 tool:id 记住哪些行不该再出现在板上。
 *
 * 为什么需要:删除是异步的(送系统回收站 + 后台重扫),而板上数据来自
 * "磁盘扫 + 板面缓存"。删完那一刻缓存里可能还有这条,重扫也可能先返回旧快照 ——
 * 只要不藏,用户就会看到"说删了但还在",于是再按一次 d,把别的文件删掉
 * (2026-11-19 的真实事故)。
 *
 * 墓碑的寿命:某次扫描结果里已经不含它 → 立刻摘掉(磁盘上确实没有了)。
 */

import type { SessionView } from "./model.ts";

export type TombstoneKey = { id: string; tool: SessionView["tool"] };

const keyOf = (key: TombstoneKey): string => `${key.tool}:${key.id}`;

export interface Tombstones {
	add(key: TombstoneKey): void;
	remove(key: TombstoneKey): void;
	has(view: TombstoneKey): boolean;
	size(): number;
	/** 过滤掉还挂着的行(没墓碑时原样返回,避免每次刷新都重建数组) */
	filter(rows: SessionView[]): SessionView[];
	/** 扫到的最新列表里已经没有它 → 摘掉墓碑 */
	prune(rows: SessionView[]): void;
}

export function createTombstones(): Tombstones {
	const keys = new Set<string>();
	return {
		add: (key) => {
			keys.add(keyOf(key));
		},
		remove: (key) => {
			keys.delete(keyOf(key));
		},
		has: (key) => keys.has(keyOf(key)),
		size: () => keys.size,
		filter: (rows) => (keys.size === 0 ? rows : rows.filter((row) => !keys.has(keyOf(row)))),
		prune: (rows) => {
			if (keys.size === 0) return;
			const present = new Set(rows.map(keyOf));
			for (const key of keys) if (!present.has(key)) keys.delete(key);
		},
	};
}
