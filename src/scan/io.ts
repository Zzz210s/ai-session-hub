/**
 * 会话文件读取工具:大文件(最大 70MB+)只读头尾,避免全量扫描拖慢列表
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 128 * 1024;

/** 读取文件头部若干字节并按行切分(末行可能被截断,由调用方忽略解析失败) */
export async function readHeadLines(file: string, bytes = HEAD_BYTES): Promise<string[]> {
	const handle = await open(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead).toString("utf8").split("\n");
	} finally {
		await handle.close();
	}
}

/** 读取文件尾部若干字节并按行切分(首行可能被截断) */
export async function readTailLines(file: string, bytes = TAIL_BYTES): Promise<string[]> {
	const info = await stat(file);
	const start = Math.max(0, info.size - bytes);
	const length = info.size - start;
	const handle = await open(file, "r");
	try {
		const buf = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buf, 0, length, start);
		return buf.subarray(0, bytesRead).toString("utf8").split("\n");
	} finally {
		await handle.close();
	}
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed[0] !== "{") return null;
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 递归收集指定目录下的文件(按扩展名过滤),目录不存在时返回空数组 */
export async function collectFiles(root: string, extension: string, maxDepth = 2): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth) await walk(full, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(extension)) {
				out.push(full);
			}
		}
	}
	await walk(root, 0);
	return out;
}

export interface FileMeta {
	mtime: Date;
	size: number;
}

export async function fileMeta(file: string): Promise<FileMeta> {
	const info = await stat(file);
	return { mtime: info.mtime, size: info.size };
}

/** 从任意层级的对象里取出第一个文本内容(claude 的 content 可能是字符串或数组) */
export function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const text = extractText(item);
			if (text) return text;
		}
		return "";
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.text === "string") return obj.text;
		if (obj.content !== undefined) return extractText(obj.content);
	}
	return "";
}

/** 压缩成单行摘要(用于列表展示) */
export function toSnippet(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "";
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 判断一段用户输入是否是机器载荷(JSON/环境变量),用于跳过而取真正的用户话题 */
export function looksLikePayload(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
	if (/^<[a-z-]+>/i.test(trimmed)) return true; // <command-name> 之类的系统包装
	if (/^Caveat:|^IMPORTANT:|^system-reminder/i.test(trimmed)) return true;
	return false;
}

/**
 * 在指定字节范围 [start, end) 内找含标记的行(按文件顺序返回)。
 * 供增量扫描使用:文件是追加写的,所以只需看上次看完之后的新增部分。
 */
export async function scanMarkedRange(file: string, marker: string, start: number, end: number, chunkSize = 4 * 1024 * 1024): Promise<string[]> {
	const out: string[] = [];
	const from = Math.max(0, start);
	const to = Math.max(from, end);
	if (to <= from) return out;
	const handle = await open(file, "r");
	try {
		let carry = "";
		const buf = Buffer.alloc(Math.min(chunkSize, to - from));
		let position = from;
		while (position < to) {
			const want = Math.min(buf.length, to - position);
			const { bytesRead } = await handle.read(buf, 0, want, position);
			if (bytesRead <= 0) break;
			position += bytesRead;
			const text = carry + buf.subarray(0, bytesRead).toString("utf8");
			const lines = text.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) if (line.includes(marker)) out.push(line);
		}
		if (carry.includes(marker)) out.push(carry);
	} finally {
		await handle.close();
	}
	return out;
}

/**
 * 从文件**尾部往前**分块找标记,遇到第一块含标记就停 —— 因为调用方要的是"最后一次出现"。
 * 好处:大多数会话文件里 session_info 就在末尾附近,一下就读完,不必全文流式扫描
 * (实测有个 195MB 的活跃会话文件,全文扫描要 13 秒)。
 */
export async function scanMarkedLinesBackwards(file: string, marker: string, chunkSize = 4 * 1024 * 1024, maxChunks = 2): Promise<string[]> {
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		return [];
	}
	let end = size;
	for (let chunk = 0; chunk < maxChunks && end > 0; chunk++) {
		const start = Math.max(0, end - chunkSize);
		const lines = await scanMarkedRange(file, marker, start, end);
		if (lines.length > 0) return lines;
		if (start === 0) break;
		end = start;
	}
	return [];
}
