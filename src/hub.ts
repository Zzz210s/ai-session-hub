/**
 * 汇总入口:扫描会话存储 + 探测活体(进程/终端标签/心跳) → 合并成带标注的视图
 *
 * 首帧策略:长驻进程(TUI)可传 staleSessions —— 立刻用上次的视图列表渲染,
 * 同时在后台重新扫描(cache/views.json,TTL 5 秒)。CLI 路径不传,保持"每次都真扫"。
 */

import { join } from "node:path";
import type { SessionView, Tool } from "./model.ts";
import { cacheDir, readCache, writeCache } from "./cache.ts";
import { planFetch } from "./stale.ts";
import { scanAllSessions } from "./scan/index.ts";
import { readHeartbeats } from "./live/heartbeat.ts";
import { probeLive } from "./live/probe.ts";
import { correlate } from "./live/correlate.ts";
import type { LiveSnapshot } from "./live/windows.ts";

export interface LoadOptions {
	tools?: Tool[];
	/** 跳过活体探测(只列历史,速度更快) */
	noLive?: boolean;
	/** 绕过缓存(强制重新探测/扫描) */
	noCache?: boolean;
	/** 活体探测缓存有效期(毫秒);TUI 用它把探测频率降到比界面刷新更低 */
	liveTtlMs?: number;
	/** 允许先用上次的探测快照渲染(后台刷新)—— 消除 PowerShell 探测造成的停顿 */
	staleLive?: boolean;
	/** 允许先用上次的视图列表渲染(后台重扫)—— 消除会话扫描造成的停顿 */
	staleSessions?: boolean;
	/** 视图缓存文件路径(测试用) */
	viewsCachePath?: string;
	/** 重新加载的实现(测试用;默认真实扫描 + 活体探测) */
	loader?: (options: LoadOptions) => Promise<LoadResult>;
}

/** 默认加载实现(供外部注入替换,如测试) */
export type ViewsLoader = (options: LoadOptions) => Promise<LoadResult>;

export interface LoadResult {
	views: SessionView[];
	live: LiveSnapshot;
	heartbeatCount: number;
}

/** 视图列表缓存:TTL 内直接用;超过 TTL 但在 STALE 内可先渲染再后台重扫 */
export const VIEWS_CACHE_TTL_MS = 5000;
export const VIEWS_CACHE_STALE_MS = 10 * 60_000;

function viewsCachePath(options: LoadOptions = {}): string {
	return options.viewsCachePath ?? join(cacheDir(), "views.json");
}

const EMPTY_LIVE: LiveSnapshot = { processes: [], tabs: [], consoleWindows: [] };

let refreshing: Promise<void> | null = null;

/** 后台重扫并回写缓存(同一时刻只跑一个,失败静默) */
function refreshViews(options: LoadOptions, path: string): void {
	if (refreshing) return;
	const load = options.loader ?? loadUncached;
	refreshing = load(options)
		.then((result) => writeCache({ path, ttlMs: VIEWS_CACHE_TTL_MS }, result.views))
		.catch(() => undefined)
		.finally(() => {
			refreshing = null;
		});
}

async function loadUncached(options: LoadOptions): Promise<LoadResult> {
	const livePromise = options.noLive
		? Promise.resolve<LiveSnapshot>(EMPTY_LIVE)
		: probeLive({ noCache: options.noCache, ttlMs: options.liveTtlMs, allowStale: options.staleLive });
	const [sessions, live, heartbeats] = await Promise.all([scanAllSessions({ tools: options.tools }), livePromise, readHeartbeats()]);
	const views = correlate({
		sessions,
		processes: live.processes,
		tabs: live.tabs,
		consoleWindows: live.consoleWindows,
		heartbeats,
	});
	return { views, live, heartbeatCount: heartbeats.length };
}

export async function loadViews(options: LoadOptions = {}): Promise<LoadResult> {
	const path = viewsCachePath(options);
	if (!options.noCache && options.staleSessions) {
		const fresh = await readCache<SessionView[]>({ path, ttlMs: VIEWS_CACHE_TTL_MS });
		const stale = fresh ? undefined : await readCache<SessionView[]>({ path, ttlMs: VIEWS_CACHE_STALE_MS });
		const plan = planFetch({ fresh, stale }, { allowStale: true });
		if (plan.use) {
			if (plan.refresh) refreshViews(options, path);
			// 缓存路径只服务"先渲染一帧",live/heartbeat 的实况由后台刷新补齐(doctor 不走这条路)
			return { views: plan.use, live: plan.refresh ? { ...EMPTY_LIVE, stale: true } : EMPTY_LIVE, heartbeatCount: 0 };
		}
	}
	const result = await (options.loader ?? loadUncached)(options);
	if (!options.noCache) await writeCache({ path, ttlMs: VIEWS_CACHE_TTL_MS }, result.views);
	return result;
}
