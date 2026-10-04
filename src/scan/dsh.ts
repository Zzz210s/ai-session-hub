/**
 * DeepSeek Harness(DSH)会话采集:$DSH_HOME(默认 ~/.dsh)下的元数据。
 *
 * 来源(全部只读,不解压正文):
 *   storages/session_projcache/sessions/<id>.json   标题、lastPromptAt、token 用量
 *   storages/workspace.json                          归档/置顶清单、工作区路径
 *   sessions/<项目slug>/<id>/session.v4.jsonl.zstd   存在性、大小、mtime
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../model.ts";

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = (env.DSH_HOME ?? "").trim();
	return explicit.length > 0 ? explicit : join(homedir(), ".dsh");
}

/** DSH 的项目 slug:--C-Users-23652-Documents-demo-- -> C:\Users\23652\Documents\demo */
export function decodeSlug(slug: string): string | undefined {
	if (!slug.startsWith("--") || !slug.endsWith("--")) return undefined;
	const inner = slug.slice(2, -2);
	if (inner.length === 0) return undefined;
	const parts = inner.split("-");
	// 首段是盘符(单字母),其余按 - 还原成路径分隔(路径里真含 - 时会失真,与 pi 的 slug 同限制)
	if (parts[0].length !== 1) return undefined;
	return `${parts[0]}:\\${parts.slice(1).join("\\")}`;
}

interface DshMeta {
	title?: string;
	lastPromptAt?: number;
	tokenTotals?: number;
}

function readMeta(json: unknown): DshMeta | undefined {
	const rows = (json as { record?: { rows?: Record<string, { val?: unknown }> } })?.record?.rows;
	if (!rows) return undefined;
	const title = (rows.title?.val as string | undefined)?.trim();
	const listMeta = rows.sessionListMetadata?.val as { lastPromptAt?: number } | undefined;
	const totals = (rows.tokenUsage?.val as { totals?: Record<string, number> } | undefined)?.totals;
	const sum = totals ? Object.values(totals).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : undefined;
	return { title, lastPromptAt: listMeta?.lastPromptAt, tokenTotals: sum };
}

async function readWorkspace(home: string): Promise<{ archived: Set<string>; pinned: Set<string> }> {
	try {
		const raw = JSON.parse(await readFile(join(home, "storages", "workspace.json"), "utf8")) as {
			global?: { archivedSessionIds?: string[]; pinnedSessionIds?: string[] };
		};
		return {
			archived: new Set(raw.global?.archivedSessionIds ?? []),
			pinned: new Set(raw.global?.pinnedSessionIds ?? []),
		};
	} catch {
		return { archived: new Set(), pinned: new Set() };
	}
}

export async function scanDshSessions(home: string = dshHome()): Promise<SessionRecord[]> {
	const metaDir = join(home, "storages", "session_projcache", "sessions");
	const sessionsRoot = join(home, "sessions");
	if (!existsSync(metaDir)) return [];
	const { archived, pinned } = await readWorkspace(home);

	// 1) 元数据:每文件一条会话
	const metas = new Map<string, { file: string; meta: DshMeta }>();
	let names: string[] = [];
	try {
		names = await readdir(metaDir);
	} catch {
		return [];
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		try {
			const meta = readMeta(JSON.parse(await readFile(join(metaDir, name), "utf8")));
			if (meta) metas.set(id, { file: join(metaDir, name), meta });
		} catch {
			/* 坏 JSON 只跳过这一条 */
		}
	}

	// 2) 正文目录:补 cwd(由 slug 反解)、大小、时间
	const records: SessionRecord[] = [];
	let slugs: string[] = [];
	try {
		slugs = (await readdir(sessionsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		slugs = [];
	}
	const seen = new Set<string>();
	for (const slug of slugs) {
		const cwd = decodeSlug(slug);
		let ids: string[] = [];
		try {
			ids = (await readdir(join(sessionsRoot, slug), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			continue;
		}
		for (const id of ids) {
			seen.add(id);
			records.push(await buildRecord(id, join(sessionsRoot, slug, id), cwd, metas, archived, pinned));
		}
	}
	// 3) 只有元数据、正文目录缺失的会话也要列出来(标记正文缺失)
	for (const [id, entry] of metas) {
		if (seen.has(id)) continue;
		records.push({
			tool: "dsh",
			id,
			file: "",
			metaFile: entry.file,
			cwd: "",
			name: entry.meta.title || undefined,
			named: Boolean(entry.meta.title),
			topic: entry.meta.title ?? "(正文缺失)",
			firstMessage: entry.meta.title ?? "",
			createdAt: new Date(entry.meta.lastPromptAt ?? 0),
			updatedAt: new Date(entry.meta.lastPromptAt ?? 0),
			archived: archived.has(id),
			pinned: pinned.has(id),
		});
	}
	return records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function buildRecord(
	id: string,
	dir: string,
	cwd: string | undefined,
	metas: Map<string, { file: string; meta: DshMeta }>,
	archived: Set<string>,
	pinned: Set<string>,
): Promise<SessionRecord> {
	const entry = metas.get(id);
	const title = entry?.meta.title ?? "";
	let size: number | undefined;
	let updated = entry?.meta.lastPromptAt ? new Date(entry.meta.lastPromptAt) : undefined;
	let created: Date | undefined;
	try {
		const fileStat = await stat(join(dir, "session.v4.jsonl.zstd"));
		size = fileStat.size;
		updated = updated ?? fileStat.mtime;
		created = fileStat.birthtime?.getTime() ? fileStat.birthtime : fileStat.ctime;
	} catch {
		/* 正文缺失,用元数据兜底 */
	}
	return {
		tool: "dsh",
		id,
		file: dir,
		metaFile: entry?.file,
		cwd: cwd ?? "",
		name: title || undefined,
		named: title.length > 0,
		topic: title || "(未命名会话)",
		firstMessage: title,
		createdAt: created ?? updated ?? new Date(0),
		updatedAt: updated ?? created ?? new Date(0),
		archived: archived.has(id),
		pinned: pinned.has(id),
		sizeBytes: size,
	};
}
