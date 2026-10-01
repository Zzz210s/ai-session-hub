/**
 * 扫描结果缓存:按文件指纹(size+mtime)记住每个会话文件的解析结果。
 *
 * 另外提供 previousScan:同一路径下"size 最大"的旧条目 —— 会话文件是追加写的,
 * 增量扫描靠它知道"上次读到哪",于是活跃会话不必每次全量重读(实测一个 197MB 的会话文件
 * 全文扫描要 10 秒以上,增量后只要几十毫秒)。
 */

import { existsSync } from "node:fs";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheDir, reviveDates, ttlFromEnv } from "../cache.ts";

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

/** 同路径下 size 最大的旧缓存条目(用于增量扫描:文件是追加写的) */
export async function previousScan<T>(file: string, ttlMs = ttlFromEnv("AIS_SCAN_TTL_MS", 24 * 3600 * 1000)): Promise<{ size: number; value: T } | undefined> {
	await ensureLoaded(ttlMs);
	const prefix = `${file}|`;
	let best: { size: number; value: T } | undefined;
	for (const [key, entry] of Object.entries(state.entries)) {
		if (!key.startsWith(prefix)) continue;
		if (best && entry.size <= best.size) continue;
		best = { size: entry.size, value: entry.value as T };
	}
	return best;
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

/** 清空缓存目录(强制刷新用):下一次读取必然重新探测/重解析 */
