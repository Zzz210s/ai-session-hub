/**
 * 磁盘缓存:带 TTL 的小工具,用于"探测/扫描结果"复用。
 *
 * 为什么需要:活体探测要起 PowerShell(UIA/进程枚举,约 1.3s),会话扫描要读 70 个
 * 文件(约 1.2s)。TUI 每 3 秒刷新一次,CLI 也常被连续调用 —— 没有缓存时每次都要
 * 重付这些成本。缓存按"文件指纹(size+mtime)"失效,保证内容变化时不会用旧数据。
 *
 * 关闭方式:AIS_CACHE=0,或 TTL 设为 0。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cacheDir(): string {
	return join(homedir(), ".ai-session-hub", "cache");
}

export interface CacheOptions {
	/** 缓存文件路径 */
	path: string;
	/** 有效期(毫秒);<=0 表示禁用 */
	ttlMs: number;
}

/** 从环境变量读取 TTL(默认 8 秒;AIS_CACHE=0 或 TTL=0 关闭) */
export function ttlFromEnv(name: string, fallbackMs: number, env: NodeJS.ProcessEnv = process.env): number {
	if (env.AIS_CACHE === "0") return 0;
	const raw = env[name];
	if (raw === undefined) return fallbackMs;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallbackMs;
}

export interface CacheEntry<T> {
	at: number;
	value: T;
}

/** 读缓存;过期/损坏/缺失返回 undefined */
export async function readCache<T>(options: CacheOptions): Promise<T | undefined> {
	if (options.ttlMs <= 0) return undefined;
	try {
		if (!existsSync(options.path)) return undefined;
		const raw = JSON.parse(await readFile(options.path, "utf8"), reviveDates) as CacheEntry<T>;
		if (!raw || typeof raw.at !== "number") return undefined;
		if (Date.now() - raw.at > options.ttlMs) return undefined;
		return raw.value;
	} catch {
		return undefined;
	}
}

/** 写缓存(先写临时文件再改名,避免并发读到半截内容) */
export async function writeCache<T>(options: CacheOptions, value: T): Promise<void> {
	if (options.ttlMs <= 0) return;
	try {
		await mkdir(dirname(options.path), { recursive: true });
		const tmp = `${options.path}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify({ at: Date.now(), value } satisfies CacheEntry<T>), "utf8");
		await rename(tmp, options.path);
	} catch {
		/* 缓存失败不影响主流程 */
	}
}

/**
 * 会话扫描缓存:按"文件 + size + mtime"作为键。
 * 只缓存"未变化的文件"的解析结果,变化即失效。
 */

export function reviveDates(key: string, value: unknown): unknown {
	if (typeof value === "string" && /At$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
	return value;
}

/** 清空整个缓存目录(会话扫描 + 视图 + 探测) */
export async function clearCache(): Promise<void> {
	const dir = cacheDir();
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	await Promise.all(
		entries.map((name) => rm(path.join(dir, name), { force: true, recursive: true }).catch(() => undefined)),
	);
}

/* 扫描结果缓存(按文件指纹)→ src/scan/cache.ts */
