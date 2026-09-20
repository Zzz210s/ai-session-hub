/**
 * pi 会话采集:读 ~/.pi/agent/sessions/<slug>/*.jsonl
 * - 头行:{type:"session", id, timestamp, cwd}
 * - 名称:{type:"session_info", name}(用 /name 命名,可能在文件中后段)
 * - 首条用户消息:{type:"message", message:{role:"user", content:[{text}]}}
 */

import { homedir } from "node:os";
import { cachedScan } from "../cache.ts";
import { basename, join } from "node:path";
import type { SessionRecord } from "../model.ts";
import { collectFiles, fileMeta, parseJsonLine, readHeadLines, readTailLines, scanMarkedLines, toSnippet } from "./io.ts";

export function piSessionsRoot(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

/** 从文件名解析会话 id:2026-09-02T09-46-31-212Z_<uuid>.jsonl */
function idFromFileName(file: string): string {
	const name = basename(file).replace(/\.jsonl$/, "");
	const underscore = name.indexOf("_");
	return underscore >= 0 ? name.slice(underscore + 1) : name;
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

	// 名称可能在任何位置(/name 可能在很久以前写入),用流式扫描找出全部 session_info
	const nameLines = await scanMarkedLines(file, '"session_info"');
	for (const line of nameLines) {
		const entry = parseJsonLine(line);
		if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
			name = entry.name.trim();
		}
	}

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
