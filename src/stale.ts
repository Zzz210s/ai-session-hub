/**
 * "先给旧的、后台刷新"(stale-while-revalidate)的决策,两处共用:
 * 活体探测(probe.ts)与视图列表(hub.ts)。
 *
 * 为什么需要:本机实测 PowerShell 活体探测 1.2-16 秒、会话扫描 0.3-1.2 秒,
 * 而 TUI 的第一帧与每次刷新都不该为一个"迟早会到"的结果空等。
 * 于是长驻进程可以允许"先用上次快照渲染",同时后台刷新,下一次刷新即拿到新的。
 */

export interface FetchLookup<T> {
	/** TTL 内命中 */
	fresh?: T;
	/** 已过期但仍在可接受年龄内 */
	stale?: T;
}

export interface FetchPlan<T> {
	/** 可直接使用的结果(无需等待) */
	use?: T;
	/** 需要同步获取 */
	fetch: boolean;
	/** 使用 use 之后需要在后台刷新 */
	refresh: boolean;
}

export function planFetch<T>(lookup: FetchLookup<T>, options: { allowStale: boolean }): FetchPlan<T> {
	if (lookup.fresh) return { use: lookup.fresh, fetch: false, refresh: false };
	if (options.allowStale && lookup.stale) return { use: lookup.stale, fetch: false, refresh: true };
	return { fetch: true, refresh: false };
}
