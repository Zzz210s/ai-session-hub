/**
 * 汇总入口:扫描会话存储 + 探测活体(进程/终端标签/心跳) → 合并成带标注的视图
 *
 * 两级缓存(见 views-cache.ts 的说明):
 *   - 扫描结果按"结构指纹 + 最长 60 秒"缓存,只有列表真变了才重扫;
 *   - 心跳与探测快照每次现读(~25ms),所以板面状态不滞后。
 * CLI(`ais list` / `ais doctor`)不带 staleSessions:每次真扫真探。
 */

import type { SessionRecord, SessionView, Tool } from "./model.ts";
import { boardCachePath, readBoardCache, shouldRescan, writeBoardCache, BOARD_CACHE_STALE_MS, BOARD_MAX_AGE_MS } from "./views-cache.ts";
import { scanAllSessions, type ScanRoots } from "./scan/index.ts";
import { sessionSignature } from "./scan/signature.ts";
import { scanInBackground } from "./scan/background.ts";
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
	/** 允许用缓存的会话列表(列表没变就不重扫)—— TUI 专用 */
	staleSessions?: boolean;
	/** 过期探测快照可接受的最大年龄(快速模式用,例如 60 秒) */
	liveStaleMs?: number;
	/** 连探测缓存都没有时也不等(界面首帧):先渲染,后台探测 */
	neverBlockLive?: boolean;
	/** 缓存文件路径 / 扫描实现 / 结构指纹(测试用) */
	viewsCachePath?: string;
	scan?: (options: { tools?: Tool[] }) => Promise<SessionRecord[]>;
	signature?: () => string;
	/** 扫描根目录覆盖(测试用) */
	roots?: ScanRoots;
}

export interface LoadResult {
	views: SessionView[];
	live: LiveSnapshot;
	heartbeatCount: number;
}

export { BOARD_CACHE_STALE_MS, BOARD_MAX_AGE_MS, boardCachePath as viewsCachePath };

const EMPTY_LIVE: LiveSnapshot = { processes: [], tabs: [], consoleWindows: [] };

let refreshing: Promise<void> | null = null;

function signatureOf(options: LoadOptions): string {
	return (options.signature ?? sessionSignature)();
}

function scanOf(options: LoadOptions, tools?: Tool[]): Promise<SessionRecord[]> {
	return (options.scan ?? scanAllSessions)({ tools: tools ?? options.tools });
}

/** 现读实况(心跳 + 探测快照),与给它的会话列表拼成视图 */
async function viewsWithLive(options: LoadOptions, sessions: SessionRecord[]): Promise<LoadResult> {
	const livePromise = options.noLive
		? Promise.resolve<LiveSnapshot>(EMPTY_LIVE)
		: probeLive({
				noCache: options.noCache,
				ttlMs: options.liveTtlMs,
				allowStale: options.staleLive ?? options.staleSessions,
				staleMs: options.liveStaleMs,
				neverBlock: options.neverBlockLive,
			});
	const [live, heartbeats] = await Promise.all([livePromise, readHeartbeats()]);
	const views = correlate({
		sessions,
		processes: live.processes,
		tabs: live.tabs,
		consoleWindows: live.consoleWindows,
		heartbeats,
	});
	return { views, live, heartbeatCount: heartbeats.length };
}

/**
 * 后台重扫并回写缓存(同一时刻只跑一个,失败静默)。
 *
 * 默认跑在 **worker 线程**里:本机实测冷读大会话文件时一次扫描可达数分钟,
 * 跑在主线程会把 TUI 卡死。注入了 options.scan(测试)时留在进程内执行。
 */
function refreshSessions(options: LoadOptions, path: string): void {
	if (refreshing) return;
	const write = (sessions: SessionRecord[] | undefined): void => {
		if (!sessions) return;
		void writeBoardCache(path, { signature: signatureOf(options), at: Date.now(), sessions });
	};
	refreshing = (options.scan ? scanOf(options) : scanInBackground({ tools: options.tools, roots: options.roots }))
		.then(write)
		.catch(() => undefined)
		.finally(() => {
			refreshing = null;
		});
}

export async function loadViews(options: LoadOptions = {}): Promise<LoadResult> {
	const path = boardCachePath(options.viewsCachePath);
	if (!options.noCache && options.staleSessions) {
		const cached = await readBoardCache(path);
		if (cached) {
			// 列表没变就不重扫(实测:按固定 TTL 判定时命中率只有 55%)
			if (shouldRescan(cached, signatureOf(options))) refreshSessions(options, path);
			return viewsWithLive(options, cached.sessions);
		}
	}
	const sessions = await scanOf(options);
	const result = await viewsWithLive(options, sessions);
	if (!options.noCache) await writeBoardCache(path, { signature: signatureOf(options), at: Date.now(), sessions });
	return result;
}
