/**
 * 心跳注册表:各 CLI 的集成把"我还在跑"写成本目录下的 JSON,最可靠的活性信号
 * 约定目录:~/.ai-sessions/live/<tool>-<pid|sessionId>.json
 */

import { homedir } from "node:os";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Heartbeat } from "../model.ts";

export function liveDir(): string {
	return join(homedir(), ".ai-sessions", "live");
}

/** 注册表目录里有多少个心跳文件(只 readdir,不读内容 —— 用于 doctor 与 GC 提示) */
export async function countHeartbeats(dir = liveDir()): Promise<number> {
	try {
		const names = await readdir(dir);
		return names.filter((name) => name.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/**
 * 心跳注册表 GC。
 *
 * 崩溃/被杀的会话会把心跳文件留在目录里(正常退出会自己删),几周后目录能积上千个文件,
 * 而每次读注册表都要 stat+read 全部文件。清理规则:
 *   - 记录损坏或时间戳无法解析 → 清(读取方本来就会忽略)
 *   - 进程已死且超 24 小时 → 清
 *   - 超过 7 天 → 清(不论 pid:避免 pid 复用后误判为“还活着”)
 *
 * 写入方(pi / claude 的心跳集成)启动时也会各自扫一遍;这里是手动按需清理的入口。
 */
export const HEARTBEAT_DEAD_AGE_MS = 24 * 3600_000;
export const HEARTBEAT_MAX_AGE_MS = 7 * 24 * 3600_000;

/** 判断哪个文件可清理(纯决策,便于单测) */
export function staleHeartbeatNames(
	entries: { name: string; info?: { pid?: unknown; updatedAt?: unknown }; broken?: boolean }[],
	now = Date.now(),
	alive: (pid: unknown) => boolean = () => true,
): string[] {
	return entries
		.filter((entry) => {
			if (!entry.name.endsWith(".json")) return false;
			if (entry.broken || !entry.info) return true;
			const age = now - Date.parse(String(entry.info.updatedAt ?? ""));
			if (!Number.isFinite(age)) return true;
			if (age > HEARTBEAT_MAX_AGE_MS) return true;
			return age > HEARTBEAT_DEAD_AGE_MS && !alive(entry.info.pid);
		})
		.map((entry) => entry.name);
}

/** 进程是否还活着(Windows 上 process.kill(pid,0) 可靠:不存在抛 ESRCH) */
export function pidAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

export interface SweepResult {
	/** 总共扫描到的文件数 */
	total: number;
	/** 判定为可清理的文件名 */
	stale: string[];
	/** 实际删除了多少(预览时为 0) */
	removed: number;
}

/** 扫描并(可选)清理注册表;只动可清理的文件,失败不抛 */
export async function sweepHeartbeats(options: { dir?: string; dryRun?: boolean; keep?: string } = {}): Promise<SweepResult> {
	const dir = options.dir ?? liveDir();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return { total: 0, stale: [], removed: 0 };
	}
	const entries: { name: string; info?: Record<string, unknown>; broken?: boolean }[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name === options.keep) continue;
		try {
			entries.push({ name, info: JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown> });
		} catch {
			entries.push({ name, broken: true });
		}
	}
	const stale = staleHeartbeatNames(entries, Date.now(), pidAlive);
	if (options.dryRun) return { total: entries.length, stale, removed: 0 };
	let removed = 0;
	for (const name of stale) {
		try {
			await rm(join(dir, name), { force: true });
			removed++;
		} catch {
			/* 别人先删了/没权限 */
		}
	}
	return { total: entries.length, stale, removed };
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
