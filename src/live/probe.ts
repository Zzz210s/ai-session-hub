/**
 * 活体探测的调度:TTL 缓存 + "允许先用过期快照、后台刷新"。
 *
 * 为什么独立成模块:探测本身(scripts/windows.ps1)是既有实现,这里的重点是**缓存策略** ——
 * PowerShell 探测在本机实测 1.2-2.3 秒(冷启动 6-7 秒),而 TUI 的第一帧不该为此空等。
 * 于是长驻进程可以 allowStale=true:立刻拿上次快照渲染,探测在后台跑,下一次刷新即可用上。
 */

import { cacheDir, readCache, ttlFromEnv, writeCache } from "../cache.ts";
import { join } from "node:path";
import { probeLiveUncached, type LiveSnapshot } from "./windows.ts";
import { planFetch } from "../stale.ts";

let refreshing: Promise<void> | null = null;

/** 后台刷新:同一时刻只跑一个,失败静默(界面不因刷新失败而挂) */
function refreshInBackground(path: string, ttlMs: number, run: () => Promise<LiveSnapshot>): void {
	if (refreshing) return;
	refreshing = run()
		.then((snapshot) => writeCache({ path, ttlMs }, snapshot))
		.catch(() => undefined)
		.finally(() => {
			refreshing = null;
		});
}

export interface LiveProbeOptions {
	noCache?: boolean;
	ttlMs?: number;
	/** 允许先返回过期快照(不超过 staleMs)并在后台刷新 —— 只有长驻进程(TUI)该用 */
	allowStale?: boolean;
	/** 过期快照可接受的最大年龄 */
	staleMs?: number;
	/** 允许"连缓存都没有时也不等":立刻返回空快照并后台探测(TUI 首帧专用) */
	neverBlock?: boolean;
	/** 缓存文件路径 / 探测实现(测试用) */
	cachePath?: string;
	probe?: () => Promise<LiveSnapshot>;
}

/** 活体探测的 TTL 缓存(默认 8 秒):TUI 每 3 秒刷新,没有缓存会反复起 PowerShell */
export async function probeLive(options: LiveProbeOptions = {}): Promise<LiveSnapshot> {
	const ttlMs = options.ttlMs ?? ttlFromEnv("AIS_LIVE_TTL_MS", 8000);
	const path = options.cachePath ?? join(cacheDir(), "live.json");
	const run = options.probe ?? probeLiveUncached;
	let plan = { fetch: true, refresh: false } as { use?: LiveSnapshot; fetch: boolean; refresh: boolean };
	if (!options.noCache) {
		const fresh = await readCache<LiveSnapshot>({ path, ttlMs });
		const staleMs = options.staleMs ?? ttlFromEnv("AIS_LIVE_STALE_MS", 10 * 60_000);
		const stale = fresh ? undefined : await readCache<LiveSnapshot>({ path, ttlMs: Math.max(staleMs, ttlMs) });
		plan = planFetch({ fresh, stale }, { allowStale: Boolean(options.allowStale) });
	}
	if (plan.use) {
		if (plan.refresh) refreshInBackground(path, ttlMs, run);
		return plan.refresh ? { ...plan.use, stale: true } : plan.use;
	}
	// 连缓存都没有:界面路径可以选择不等(先渲染"暂无实况",后台探测完下一次刷新就是真的)
	if (options.neverBlock) {
		refreshInBackground(path, ttlMs, run);
		return { processes: [], tabs: [], consoleWindows: [], stale: true };
	}
	const fresh = await run();
	// 等写盘完成:短命进程(ais list)否则可能在退出前丢掉缓存,导致下次又要全量探测
	if (!options.noCache) await writeCache({ path, ttlMs }, fresh);
	return fresh;
}
