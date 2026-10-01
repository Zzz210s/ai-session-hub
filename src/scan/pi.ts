/**
 * pi 会话采集:读 ~/.pi/agent/sessions/<slug>/*.jsonl
 * - 头行:{type:"session", id, timestamp, cwd}
 * - 名称:{type:"session_info", name}(用 /name 命名,可能在文件中后段)
 * - 首条用户消息:{type:"message", message:{role:"user", content:[{text}]}}
 */

import { homedir } from "node:os";
import { cachedScan, previousScan } from "./cache.ts";
import { basename, join } from "node:path";
import type { SessionRecord } from "../model.ts";
import { collectFiles, fileMeta, parseJsonLine, readHeadLines, readTailLines, scanMarkedRange, scanMarkedLinesBackwards, toSnippet } from "./io.ts";

export function piSessionsRoot(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

/** 从文件名解析会话 id:2026-09-02T09-46-31-212Z_<uuid>.jsonl */
function idFromFileName(file: string): string {
	const name = basename(file).replace(/\.jsonl$/, "");
	const underscore = name.indexOf("_");
	return underscore >= 0 ? name.slice(underscore + 1) : name;
}

/** 上一次解析得到的名字(用于增量:文件长大了但新增部分没有 session_info 时沿用) */
async function previousNameOf(file: string): Promise<string | undefined> {
	const previous = await previousScan<SessionRecord>(file);
	return previous?.value?.name;
}

/** 上次已看完的字节位置(同路径里 size 最大的那条记录的大小) */
async function previousSizeOf(file: string): Promise<number> {
	const previous = await previousScan<SessionRecord>(file);
	return previous?.size ?? 0;
}

function lastSessionInfoName(lines: string[], fallback?: string): string | undefined {
	let name = fallback;
	for (const line of lines) {
		const entry = parseJsonLine(line);
		if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
	}
	return name;
}

/**
 * 找出会话名(session_info 的最后一条)。三层策略,最坏也只读"文件头 + 尾部若干块":
 *   1. 文件比上次看到的更长 → 只看新增的那段(追加写,新名字只可能在这里)—— 常态路径,几毫秒
 *   2. 尾部 8MB 往前找(名字通常在最近改过的地方)
 *   3. 文件头 256KB(名字常常在会话开头就写好)
 * 不做全文流式扫描:一个 197MB 的会话文件,全文扫描要 10 秒以上,而它只值一个显示名。
 */
export async function findSessionName(file: string, size: number, previousName?: string): Promise<string | undefined> {
	const scannedTo = await previousSizeOf(file);
	if (scannedTo > 0 && size > scannedTo) {
		return lastSessionInfoName(await scanMarkedRange(file, '"session_info"', scannedTo, size), previousName);
	}
	const tailName = lastSessionInfoName(await scanMarkedLinesBackwards(file, '"session_info"', 4 * 1024 * 1024, 2), previousName);
	if (tailName !== previousName) return tailName;
	const headName = lastSessionInfoName(await scanMarkedRange(file, '"session_info"', 0, Math.min(size, 256 * 1024)), tailName);
	return headName ?? tailName;
}

export async function parsePiSession(file: string): Promise<SessionRecord | null> {
	const [headLines, tailLines, meta] = await Promise.all([
		readHeadLines(file),
		readTailLines(file),
		fileMeta(file),
	]);

	let id = idFromFileName(file);
	let cwd = "";
	let createdAt: Date | null = null;
	let firstMessage = "";
	let name: string | undefined;
	let parentId: string | undefined;

	for (const line of headLines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (entry.type === "session") {
			if (typeof entry.id === "string") id = entry.id;
			if (typeof entry.cwd === "string") cwd = entry.cwd;
			if (typeof entry.timestamp === "string") createdAt = new Date(entry.timestamp);
			if (typeof entry.parentSession === "string") parentId = entry.parentSession;
			continue;
		}
		if (!firstMessage && entry.type === "message") {
			const message = entry.message as Record<string, unknown> | undefined;
			if (message?.role === "user") {
				const text = extractUserText(message.content);
				if (text) firstMessage = text;
			}
		}
	}

	// 名称(/name 或主题)写在 session_info 里,最后一条为准。
	// 文件是追加写的,所以:有上次的记录就只看新增字节,否则从尾部往前找第一块含标记的
	// —— 全文流式扫描过一个大文件要 13 秒,这个是"扫描卡顿"的真凶。
	name = await findSessionName(file, meta.size, await previousNameOf(file));

	// 分叉信息通常在头部,尾部再兜底一次
	for (const line of tailLines) {
		const entry = parseJsonLine(line);
		if (entry && typeof entry.parentSession === "string" && entry.parentSession) parentId = entry.parentSession;
	}

	if (!createdAt) createdAt = meta.mtime;
	return {
		tool: "pi",
		id,
		file,
		cwd,
		name,
		named: Boolean(name),
		topic: name ?? toSnippet(firstMessage) ?? "",
		firstMessage,
		createdAt,
		updatedAt: meta.mtime,
		sizeBytes: meta.size,
		parentId,
	};
}

function extractUserText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object") {
			const text = (part as Record<string, unknown>).text;
			if (typeof text === "string" && text.trim() && !text.trim().startsWith("<")) return text.trim();
		}
	}
	return "";
}

export async function scanPiSessions(): Promise<SessionRecord[]> {
	const files = await collectFiles(piSessionsRoot(), ".jsonl", 2);
	const out: SessionRecord[] = [];
	for (const file of files) {
		try {
			// 按文件指纹缓存:未变化的会话文件不再重复解析(冷扫描 ~1.2s -> 热扫描 ~0.1s)
			const record = await cachedScan(file, () => parsePiSession(file));
			if (record) out.push(record);
		} catch {
			/* 单个文件损坏不影响整体 */
		}
	}
	return out;
}
