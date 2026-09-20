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
}

export interface LoadResult {
	views: SessionView[];
	live: LiveSnapshot;
	heartbeatCount: number;
}

export async function loadViews(options: LoadOptions = {}): Promise<LoadResult> {
	const livePromise = options.noLive
		? Promise.resolve<LiveSnapshot>({ processes: [], tabs: [] })
		: probeLive();
	const [sessions, live, heartbeats] = await Promise.all([scanAllSessions({ tools: options.tools }), livePromise, readHeartbeats()]);

	const views = correlate({
		sessions,
		processes: live.processes,
		tabs: live.tabs,
		heartbeats,
	});
	return { views, live, heartbeatCount: heartbeats.length };
}
