/**
 * 心跳注册表:各 CLI 的集成把"我还在跑"写成本目录下的 JSON,最可靠的活性信号
 * 约定目录:~/.ai-sessions/live/<tool>-<pid|sessionId>.json
 */

import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Heartbeat } from "../model.ts";

export function liveDir(): string {
	return join(homedir(), ".ai-sessions", "live");
}

/** 心跳超过该时长即视为失效(CLI 崩溃未清理时兜底) */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;

export async function readHeartbeats(now = new Date()): Promise<Heartbeat[]> {
	let names: string[];
	try {
		names = await readdir(liveDir());
	} catch {
		return [];
	}
	const out: Heartbeat[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(liveDir(), name), "utf8");
			const parsed = JSON.parse(raw) as Heartbeat;
			if (!parsed || typeof parsed.sessionId !== "string") continue;
			const updated = new Date(parsed.updatedAt ?? 0);
			if (Number.isNaN(updated.getTime())) continue;
			if (now.getTime() - updated.getTime() > HEARTBEAT_STALE_MS) continue;
			out.push(parsed);
		} catch {
			/* 损坏的心跳文件忽略 */
		}
	}
	return out;
}

/** 判定进程是否仍存活(用于心跳与进程表交叉验证) */
export function processAlive(pid: number | undefined, processes: { pid: number }[]): boolean {
	if (!pid) return false;
	return processes.some((p) => p.pid === pid);
}
