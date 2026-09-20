/**
 * Claude Code 会话采集:读 ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 * - {type:"mode"|"permission-mode"|"file-history-snapshot", sessionId}
 * - {type:"user", cwd, timestamp, gitBranch, message:{role,content}}
 * - {type:"summary", summary}(压缩/恢复后会写)
 * 名称:Claude Code 无独立命名字段,展示用 summary 或首条自然语言用户消息
 */

import { homedir } from "node:os";
import { cachedScan } from "../cache.ts";
import { basename, join } from "node:path";
import type { SessionRecord } from "../model.ts";
import {
	collectFiles,
	extractText,
	fileMeta,
	looksLikePayload,
	parseJsonLine,
	readHeadLines,
	readTailLines,
	toSnippet,
} from "./io.ts";

export function claudeProjectsRoot(): string {
	return join(homedir(), ".claude", "projects");
}

export async function parseClaudeSession(file: string): Promise<SessionRecord | null> {
	const [headLines, tailLines, meta] = await Promise.all([
		readHeadLines(file),
		readTailLines(file),
		fileMeta(file),
	]);

	let id = basename(file).replace(/\.jsonl$/, "");
	let cwd = "";
	let createdAt: Date | null = null;
	let firstMessage = "";
	let summary = "";
	let parentId: string | undefined;

	for (const line of headLines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (typeof entry.sessionId === "string" && entry.sessionId) id = entry.sessionId;
		if (typeof entry.cwd === "string" && entry.cwd && !cwd) cwd = entry.cwd;
		if (typeof entry.timestamp === "string" && !createdAt) {
			const parsed = new Date(entry.timestamp);
			if (!Number.isNaN(parsed.getTime())) createdAt = parsed;
		}
		if (entry.type === "summary" && typeof entry.summary === "string" && !summary) {
			summary = entry.summary.trim();
		}
		if (!firstMessage && entry.type === "user") {
			const message = entry.message as Record<string, unknown> | undefined;
			const text = extractText(message?.content).trim();
			if (text && !looksLikePayload(text)) firstMessage = text;
		}
	}

	// 摘要常在文件末尾(压缩时写入),也用于回填 cwd
	for (const line of tailLines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (entry.type === "summary" && typeof entry.summary === "string" && entry.summary.trim()) {
			summary = entry.summary.trim();
		}
		if (!cwd && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
		if (typeof entry.parentUuid === "string" && entry.parentUuid) parentId = entry.parentUuid;
	}

	if (!createdAt) createdAt = meta.mtime;
	const topic = summary || toSnippet(firstMessage);
	return {
		tool: "claude",
		id,
		file,
		cwd,
		name: summary ? summary.slice(0, 200) : undefined, // 列表由 title() 截断;详情面板要完整显示,故多留一些
		topic,
		firstMessage,
		createdAt,
		updatedAt: meta.mtime,
		sizeBytes: meta.size,
		parentId,
	};
}

export async function scanClaudeSessions(): Promise<SessionRecord[]> {
	const files = await collectFiles(claudeProjectsRoot(), ".jsonl", 2);
	const out: SessionRecord[] = [];
	for (const file of files) {
		try {
			// 按文件指纹缓存:未变化的会话文件不再重复解析(冷扫描 ~1.2s -> 热扫描 ~0.1s)
			const record = await cachedScan(file, () => parseClaudeSession(file));
			if (record) out.push(record);
		} catch {
			/* 跳过损坏文件 */
		}
	}
	return out;
}
