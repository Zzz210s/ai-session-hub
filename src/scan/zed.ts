/**
 * Zed agent 线程采集:只读 %LOCALAPPDATA%\Zed\threads\threads.db(SQLite)。
 * 表 threads 的列:id/summary/updated_at/created_at/folder_paths/parent_id/data(zstd BLOB)。
 * 只取元数据,**不解压 data** —— 列标题不需要正文。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../model.ts";
import { fileMeta } from "./io.ts";

export function zedThreadsDbPath(env: NodeJS.ProcessEnv = process.env): string {
	if (process.platform === "win32") {
		const local = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
		return join(local, "Zed", "threads", "threads.db");
	}
	return join(homedir(), ".local", "share", "zed", "threads", "threads.db");
}

/** Zed 的时间戳形如 2026-09-03T12:57:57.162282600+00:00(9 位小数);JS 只认 3 位 */
export function parseZedTime(value: unknown): Date | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const fixed = value.replace(/\.(\d{3})\d*/, ".$1");
	const parsed = Date.parse(fixed);
	return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

/** folder_paths 可能是单个路径字符串,也可能是 JSON 数组(多根工作区) */
export function firstFolder(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "";
	const text = value.trim();
	if (text.startsWith("[")) {
		try {
			const list = JSON.parse(text) as unknown;
			if (Array.isArray(list) && typeof list[0] === "string") return list[0];
		} catch {
			// 解析失败:按设计留空
		}
		// JSON 数组但首元素非字符串 / 空数组 / 解析失败,都返回空串
		return "";
	}
	return text;
}

interface ZedRow {
	id: string;
	summary: string | null;
	updated_at: string | null;
	created_at: string | null;
	folder_paths: string | null;
	parent_id: string | null;
	size: number | null;
}

export async function scanZedSessions(dbPath: string = zedThreadsDbPath()): Promise<SessionRecord[]> {
	if (!existsSync(dbPath)) return [];
	try {
		// 时间解析失败时用文件 mtime 兜底(设计 §4);循环外取一次,避免每行重复 stat
		const meta = await fileMeta(dbPath).catch(() => null);
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const rows = db
				.prepare(
					"SELECT id, summary, updated_at, created_at, folder_paths, parent_id, length(data) AS size FROM threads ORDER BY updated_at DESC",
				)
				.all() as unknown as ZedRow[];
			return rows.map((row) => {
				const title = (row.summary ?? "").trim();
				const created = parseZedTime(row.created_at);
				const updated = parseZedTime(row.updated_at);
				return {
					tool: "zed" as const,
					id: row.id,
					file: dbPath,
					cwd: firstFolder(row.folder_paths),
					name: title || undefined,
					// 与 opencode 一致:Zed 的 summary 是自动生成标题,不算“用户命名”
					named: false,
					topic: title,
					// Zed 的正文是 zstd blob,不解压,所以这里用摘要代替首条用户消息(勿当原文搜索)
					firstMessage: title,
					createdAt: created ?? updated ?? meta?.mtime ?? new Date(0),
					updatedAt: updated ?? created ?? meta?.mtime ?? new Date(0),
					parentId: row.parent_id ?? undefined,
					sizeBytes: row.size ?? undefined,
				};
			});
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}
