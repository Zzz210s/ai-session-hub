/**
 * 汇总入口:扫描会话存储 + 探测活体(进程/终端标签/心跳) → 合并成带标注的视图
 *
 * 两级缓存(见 views-cache.ts 的说明):
 *   - 扫描结果按"结构指纹 + 最长 60 秒"缓存,只有列表真变了才重扫;
 *   - 心跳与探测快照每次现读(~25ms),所以板面状态不滞后。
 * CLI(`ais list` / `ais doctor`)不带 staleSessions:每次真扫真探。
 */

import type { LiveApp, SessionRecord, SessionView, Tool } from "./model.ts";
import { boardCachePath, readBoardCache, shouldRescan, writeBoardCache, BOARD_CACHE_STALE_MS, BOARD_MAX_AGE_MS, type BoardCacheValue } from "./views-cache.ts";
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
	/** 连板面缓存都没有时也不等(首次运行的界面首帧):先给空板,后台 worker 扫完再刷新 */
	neverBlockSessions?: boolean;
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

/**
 * "同步真扫"写过几次缓存。
 *
 * 要防的场景是删除后的幽灵行:后台扫描在删除**之前**开始,删除后我们同步重扫并写了新缓存,
 * 可那个慢扫描随后才结束,把**含已删会话**的旧列表又写回去 —— 界面上被删的那条又冒出来
 * (文件其实已经进回收站),要等下一次真重扫(最长 20 秒)才消失。
 *
 * 规则:同步扫描的结果永远最新,它写入时把序号 +1;后台扫描在写之前对一下自己启动时记的
 * 序号,不一致就作废。
 */
let inlineWriteSeq = 0;

async function writeInlineCache(path: string, value: BoardCacheValue): Promise<void> {
	inlineWriteSeq += 1;
	await writeBoardCache(path, value);
}

function writeWorkerCache(path: string, value: BoardCacheValue, seqAtStart: number): void {
	if (seqAtStart !== inlineWriteSeq) return;
	void writeBoardCache(path, value);
}

function signatureOf(options: LoadOptions): string {
	return (options.signature ?? sessionSignature)();
}

function scanOf(options: LoadOptions, tools?: Tool[]): Promise<SessionRecord[]> {
	// roots 必须转发:漏掉它时,带 roots 的调用(测试、临时根)会静默去扫真实会话存储 ——
	// 2026-11 排查删除问题时实测到(探针脚本本意只扫临时目录,却列出了全部真实会话)
	return (options.scan ?? scanAllSessions)({ tools: tools ?? options.tools, roots: options.roots });
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
	// apps 由任务 7 的探测侧填充;此处前向兼容读,缺失时 correlate 按空集处理
	const apps = (live as LiveSnapshot & { apps?: LiveApp[] }).apps;
	const views = correlate({
		sessions,
		processes: live.processes,
		tabs: live.tabs,
		consoleWindows: live.consoleWindows,
		heartbeats,
		apps,
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
	const seqAtStart = inlineWriteSeq;
	const write = (sessions: SessionRecord[] | undefined): void => {
		if (!sessions) return;
		// 扫描期间有人(比如删除后的强制重扫)写过更新的一版 → 这次结果作废
		writeWorkerCache(path, { signature: signatureOf(options), at: Date.now(), sessions }, seqAtStart);
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
		// 首次运行(还没有板面缓存):界面不该等一次可能是几分钟的冷扫描 —— 先给空板,
		// worker 扫完写回缓存,下一次刷新(≤3 秒)自然就有了
		if (options.neverBlockSessions) {
			refreshSessions(options, path);
			return viewsWithLive(options, []);
		}
	}
	const sessions = await scanOf(options);
	const result = await viewsWithLive(options, sessions);
	// 这条路是"同步真扫"(删除后刷新走这里):结果最新,写入时让在途的慢扫描作废
	if (!options.noCache) await writeInlineCache(path, { signature: signatureOf(options), at: Date.now(), sessions });
	return result;
}
