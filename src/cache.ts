/**
 * 磁盘缓存:带 TTL 的小工具,用于"探测/扫描结果"复用。
 *
 * 为什么需要:活体探测要起 PowerShell(UIA/进程枚举,约 1.3s),会话扫描要读 70 个
 * 文件(约 1.2s)。TUI 每 3 秒刷新一次,CLI 也常被连续调用 —— 没有缓存时每次都要
 * 重付这些成本。缓存按"文件指纹(size+mtime)"失效,保证内容变化时不会用旧数据。
 *
 * 关闭方式:AIS_CACHE=0,或 TTL 设为 0。
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
export interface ScanCacheEntry<T> {
	size: number;
	mtimeMs: number;
	value: T;
}

export type ScanCache<T> = Record<string, ScanCacheEntry<T>>;

export async function readScanCache<T>(path: string): Promise<ScanCache<T>> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(await readFile(path, "utf8")) as { entries?: ScanCache<T> };
		return raw?.entries ?? {};
	} catch {
		return {};
	}
}

export async function writeScanCache<T>(path: string, entries: ScanCache<T>): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify({ entries }), "utf8");
		await rename(tmp, path);
	} catch {
		/* 忽略 */
	}
}

/** 缓存键:文件路径 + 大小 + mtime */
export function scanKey(file: string, size: number, mtimeMs: number): string {
	return `${file}|${size}|${Math.round(mtimeMs)}`;
}

/* ---------- 扫描结果缓存(按文件指纹) ---------- */

interface ScanState<T> {
	entries: ScanCache<T>;
	dirty: boolean;
	loaded: boolean;
}

const state: ScanState<unknown> = { entries: {}, dirty: false, loaded: false };

/** Date 字段在 JSON 里会变成字符串,读回时按字段名恢复(createdAt/updatedAt/startedAt/...At) */
export function reviveDates(key: string, value: unknown): unknown {
	if (typeof value === "string" && /At$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
	return value;
}

export function scanCachePath(): string {
	return join(cacheDir(), "sessions.json");
}

/** 载入缓存(只做一次);AIS_CACHE=0 时直接跳过 */
async function ensureLoaded(ttlMs: number): Promise<void> {
	if (state.loaded || ttlMs <= 0) return;
	state.loaded = true;
	try {
		const raw = JSON.parse(await readFile(scanCachePath(), "utf8"), reviveDates) as { entries?: ScanCache<unknown> };
		state.entries = raw?.entries ?? {};
		// 修剪:只保留最近 800 条,避免无限增长
		const keys = Object.keys(state.entries);
		if (keys.length > 800) {
			const kept: ScanCache<unknown> = {};
			for (const key of keys.slice(keys.length - 800)) kept[key] = state.entries[key];
			state.entries = kept;
			state.dirty = true;
		}
	} catch {
		state.entries = {};
	}
}

/**
 * 按文件指纹缓存解析结果:文件未变(size+mtime 相同)则直接返回上次结果。
 * 这让"第二次起"的扫描从 ~1.2s 降到 ~0.1s。
 */
export async function cachedScan<T>(file: string, compute: () => Promise<T>, ttlMs = ttlFromEnv("AIS_SCAN_TTL_MS", 24 * 3600 * 1000)): Promise<T> {
	await ensureLoaded(ttlMs);
	if (ttlMs <= 0) return compute();
	let size = 0;
	let mtimeMs = 0;
	try {
		const info = await stat(file);
		size = info.size;
		mtimeMs = info.mtimeMs;
	} catch {
		return compute(); // 拿不到指纹就不缓存
	}
	const key = scanKey(file, size, mtimeMs);
	const hit = state.entries[key];
	if (hit) return hit.value as T;
	const value = await compute();
	state.entries[key] = { size, mtimeMs, value };
	state.dirty = true;
	return value;
}

/** 落盘(进程退出前调用;失败静默) */
export async function flushScanCache(): Promise<void> {
	if (!state.dirty) return;
	try {
		await writeScanCache(scanCachePath(), state.entries);
		state.dirty = false;
	} catch {
		/* 忽略 */
	}
}
