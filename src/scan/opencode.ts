/**
 * opencode 会话采集:读 ~/.local/share/opencode/opencode.db(SQLite,drizzle)
 * session 表:id, project_id, directory, title, parent_id, time_created, time_updated, model, cost, tokens_*
 * project 表:id, worktree, name
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../model.ts";
import { fileMeta } from "./io.ts";

export function opencodeDbPath(): string {
	return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

interface OpenCodeRow {
	id: string;
	project_id: string | null;
	directory: string | null;
	title: string | null;
	parent_id: string | null;
	time_created: number | string | null;
	time_updated: number | string | null;
}

function toDate(value: number | string | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	const num = typeof value === "string" ? Number(value) : value;
	if (!Number.isFinite(num) || num <= 0) return null;
	// opencode 使用毫秒时间戳(>1e12);兼容秒级
	return new Date(num > 1e12 ? num : num * 1000);
}

export async function scanOpenCodeSessions(): Promise<SessionRecord[]> {
	const dbPath = opencodeDbPath();
	try {
		const meta = await fileMeta(dbPath);
		// 动态导入:让 node:sqlite 的实验特性警告在 cli 安装警告过滤器之后再触发
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const rows = db
				.prepare(
					"SELECT id, project_id, directory, title, parent_id, time_created, time_updated FROM session ORDER BY time_updated DESC",
				)
				.all() as unknown as OpenCodeRow[];
			return rows.map((row) => {
				const createdAt = toDate(row.time_created) ?? meta.mtime;
				const updatedAt = toDate(row.time_updated) ?? meta.mtime;
				const title = (row.title ?? "").trim();
				return {
					tool: "opencode" as const,
					id: row.id,
					file: dbPath,
					cwd: row.directory ?? "",
					name: title || undefined,
					topic: title,
					firstMessage: title,
					createdAt,
					updatedAt,
					parentId: row.parent_id ?? undefined,
				};
			});
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}
