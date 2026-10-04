/**
 * 后台扫描(worker 线程)与它的降级路径。
 *
 * 目标:任何"重新扫描会话存储"的动作都不能卡住调用方的事件循环 ——
 * 实测冷读大会话文件时一次扫描可达数分钟,跑在主线程里界面会僵住。
 *
 * 三条约束:
 *   1. 同一时刻只跑一个扫描(结果只用于覆盖缓存,多跑无意义)
 *   2. worker 起不来 / 报错 / 卡死 → 降级:卡死就丢弃这次(不改用主线程重扫,避免把主线程拖住)
 *   3. 结果必须是"最后一次扫描的完整列表",所以宁可跳过也不要拼半份数据
 */

import { Worker } from "node:worker_threads";
import type { SessionRecord, Tool } from "../model.ts";
import type { ScanRoots } from "./index.ts";

/** 与 Worker 实例兼容的最小接口(便于单测注入假对象) */
export interface WorkerLike {
	on(event: "message", handler: (message: unknown) => void): unknown;
	on(event: "error", handler: (error: Error) => void): unknown;
	on(event: "exit", handler: (code: number) => void): unknown;
	terminate(): unknown;
}

export type WorkerFactory = () => WorkerLike;

/** 扫描在途时超过这么久就认为卡死:丢弃并允许下次重试(worker 里是纯 I/O,正常不会这么久) */
export const SCAN_STUCK_MS = 10 * 60 * 1000;

export interface BackgroundScanOptions {
	tools?: Tool[];
	roots?: ScanRoots;
	/** 注入 worker 工厂(测试用);默认起真 worker */
	spawn?: WorkerFactory;
	/** 在途任务的时间戳提供者(测试用) */
	now?: () => number;
	/** 单次扫描的最长等待(测试用;默认 SCAN_STUCK_MS) */
	stuckMs?: number;
}

interface InFlight {
	startedAt: number;
	promise: Promise<SessionRecord[] | undefined>;
}

let inFlight: InFlight | null = null;

/**
 * 可以带给 worker 的主线程参数(白名单)。
 *
 * 不能直接沿用 `process.execArgv`:在 `node --test` 下它是一长串测试运行器参数
 * (`--test-isolation=process`、`--test-concurrency=0`、`--inspect-port=…` …),
 * 原样传给 worker 会让 worker 进入测试模式/端口冲突 —— 实测表现为 worker 立刻报错退出。
 */
const FORWARDABLE_ARGV = /^--(no-warnings|expose-internals|experimental-[a-z-]+|enable-source-maps)$/;

function defaultSpawn(tools: Tool[] | undefined, roots: ScanRoots | undefined): WorkerLike {
	return new Worker(new URL("./worker.ts", import.meta.url), {
		workerData: { tools, roots },
		execArgv: process.execArgv.filter((arg) => FORWARDABLE_ARGV.test(arg)),
	}) as unknown as WorkerLike;
}

/** 跑一次 worker 扫描;worker 报错/提前退出时返回 undefined(调用方保留旧缓存) */
function runWorker(spawn: WorkerFactory, timeoutMs: number): Promise<SessionRecord[] | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: SessionRecord[] | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let worker: WorkerLike;
		try {
			worker = spawn();
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			// 卡死:丢弃本次,终止 worker(不降级到主线程,否则等于把卡顿搬回来)
			void worker.terminate();
			finish(undefined);
		}, timeoutMs);
		timer.unref?.();
		worker.on("message", (message) => {
			const payload = message as { ok?: boolean; records?: SessionRecord[] } | null;
			void worker.terminate();
			finish(payload?.ok && Array.isArray(payload.records) ? payload.records : undefined);
		});
		worker.on("error", () => finish(undefined));
		worker.on("exit", (code) => {
			if (code !== 0) finish(undefined);
		});
	});
}

/**
 * 在 worker 线程里重扫;同一时刻只跑一个。
 * 返回 undefined 表示"这次没有新结果"(worker 失败、卡死、或已有扫描在跑)。
 */
export function scanInBackground(options: BackgroundScanOptions = {}): Promise<SessionRecord[] | undefined> {
	const now = options.now ?? Date.now;
	if (inFlight && now() - inFlight.startedAt < SCAN_STUCK_MS) return Promise.resolve(undefined);
	const stuckMs = options.stuckMs ?? SCAN_STUCK_MS;
	const spawn = options.spawn ?? (() => defaultSpawn(options.tools, options.roots));
	const promise = runWorker(spawn, stuckMs);
	const entry: InFlight = { startedAt: now(), promise };
	inFlight = entry;
	void promise.finally(() => {
		if (inFlight === entry) inFlight = null;
	});
	return promise;
}

/** 仅测试用:清掉在途标记 */
export function resetBackgroundScan(): void {
	inFlight = null;
}
