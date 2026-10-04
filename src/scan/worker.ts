/**
 * 扫描 worker 入口:在**独立线程**里扫描会话存储。
 *
 * 为什么需要:扫描要读会话文件,而本机实测"首次读一个 206MB 会话文件"可能要十几秒
 * (杀软实时扫描),整次冷扫描可达数分钟 —— 如果跑在 TUI 的事件循环里,界面就会卡死。
 * 放到 worker 后,主线程继续渲染/响应按键,扫描结果下一次刷新再取。
 *
 * 只做一件事:收任务 → 扫描 → 回传记录(structured clone 会保留 Date)。失败也回传,由父线程决定降级。
 */

import { parentPort, workerData } from "node:worker_threads";
import type { Tool } from "../model.ts";
import { flushScanCache } from "./cache.ts";
import { scanAllSessions, type ScanRoots } from "./index.ts";

interface ScanTask {
	tools?: Tool[];
	roots?: ScanRoots;
}

const task = (workerData ?? {}) as ScanTask;

scanAllSessions({ tools: task.tools, roots: task.roots })
	.then(async (records) => {
		// 把本次的解析结果落盘:worker 有自己的模块状态,不写回的话主线程与下次扫描都要重算
		await flushScanCache();
		parentPort?.postMessage({ ok: true, records });
	})
	.catch((error: unknown) => {
		parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
	});
