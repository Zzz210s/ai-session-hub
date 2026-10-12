/**
 * 板面缓存:缓存**扫描结果**(会话列表),而实况(心跳/标签)每次都现读。
 *
 * 为什么这么分:
 *   - 扫描会话存储是重活(实测 0.3-1.2 秒,500 个文件的 stat + 变过文件的解析),而它只在
 *     "出现新会话/会话消失/文件内容变了"时才需要重做;
 *   - 心跳 + 探测快照很便宜(~25ms),而它们决定板面上最常变的"运行中/工作/等待"状态。
 *
 * 早先的实现把两者一起按固定 TTL(5 秒)缓存,实测每 3 秒刷一次时命中率只有 **55%** ——
 * 面板没变也每 5 秒空扫一次。现在按"结构指纹 + 最长 60 秒"决定要不要重扫,实况永远新鲜。
 */

import { join } from "node:path";
import type { SessionRecord } from "./model.ts";
import { cacheDir, readCache, writeCache } from "./cache.ts";

/**
 * 即使指纹没变,也至少这么久重扫一次(兜底:会话文件里的话题/时间在变)。
 *
 * 取 20 秒的原因:改会话名只改文件内容、不改目录 mtime,所以指纹察觉不到 —— 重扫是唯一
 * 能让板面跟上改名的机制。重扫跑在 worker 线程里(见 scan/background.ts),不阻塞界面,
 * 所以可以把间隔压得比 60 秒短得多。
 */
export const BOARD_MAX_AGE_MS = 20_000;
/**
 * 缓存可用窗口(超过就视为没有缓存,首帧只能先给空板再等后台扫描)。
 *
 * 2026-10-12 从 10 分钟放宽到 6 小时:用户日常几乎总是"隔几小时才开一次 ais",
 * 10 分钟的窗口等于首帧永远空白、要等后台扫描(冷扫描可达数秒)才看到内容 —— 那也是"启动慢"的一部分。
 * 放宽后首帧立刻用上次的板面渲染,而 `shouldRescan`(指纹变了或超过 BOARD_MAX_AGE_MS=20 秒)
 * 仍会触发后台重扫,所以最多 3 秒(一次刷新节拍)后就是新数据;期间 TUI 会显示
 * `板面为上次快照,正在后台刷新…` 如实说明(见 hub.ts 的 staleBoard)。
 */
export const BOARD_CACHE_STALE_MS = 6 * 60 * 60_000;

export interface BoardCacheValue {
	/** 会话存储的结构指纹(见 scan/signature.ts) */
	signature: string;
	/** 写入时间(自己记:readCache 只返回 value) */
	at: number;
	sessions: SessionRecord[];
}

export function boardCachePath(override?: string): string {
	return override ?? join(cacheDir(), "views.json");
}

/** 读板面缓存;兼容旧格式(裸视图数组 = 无会话数据,视为需要重扫) */
export async function readBoardCache(path: string): Promise<BoardCacheValue | undefined> {
	const value = await readCache<BoardCacheValue | unknown[]>({ path, ttlMs: BOARD_CACHE_STALE_MS });
	if (!value) return undefined;
	if (Array.isArray(value) || !Array.isArray(value.sessions)) return undefined;
	return value;
}

export async function writeBoardCache(path: string, value: BoardCacheValue): Promise<void> {
	await writeCache({ path, ttlMs: BOARD_CACHE_STALE_MS }, value);
}

/** 现在该不该重扫:结构指纹变了、或超过最长陈旧时间(纯判定,便于单测) */
export function shouldRescan(cached: Pick<BoardCacheValue, "signature" | "at">, signature: string, now = Date.now()): boolean {
	if (signature !== cached.signature) return true;
	return now - cached.at >= BOARD_MAX_AGE_MS;
}
