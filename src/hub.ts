/**
 * 汇总入口:扫描会话存储 + 探测活体(进程/终端标签/心跳) → 合并成带标注的视图
 */

import type { SessionView, Tool } from "./model.ts";
import { scanAllSessions } from "./scan/index.ts";
import { readHeartbeats } from "./live/heartbeat.ts";
import { probeLive, type LiveSnapshot } from "./live/windows.ts";
import { correlate } from "./live/correlate.ts";

export interface LoadOptions {
	tools?: Tool[];
	/** 跳过活体探测(只列历史,速度更快) */
	noLive?: boolean;
	/** 绕过缓存(强制重新探测/扫描) */
	noCache?: boolean;
	/** 活体探测缓存有效期(毫秒);TUI 用它把探测频率降到比界面刷新更低 */
	liveTtlMs?: number;
}

export interface LoadResult {
	views: SessionView[];
	live: LiveSnapshot;
	heartbeatCount: number;
}

export async function loadViews(options: LoadOptions = {}): Promise<LoadResult> {
	const livePromise = options.noLive
		? Promise.resolve<LiveSnapshot>({ processes: [], tabs: [], consoleWindows: [] })
		: probeLive({ noCache: options.noCache, ttlMs: options.liveTtlMs });
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
