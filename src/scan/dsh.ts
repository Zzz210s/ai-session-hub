/**
 * DeepSeek Harness(DSH)会话采集:$DSH_HOME(默认 ~/.dsh)下的元数据。
 *
 * 来源(全部只读,不解压正文):
 *   storages/session_projcache/sessions/<id>.json   标题、lastPromptAt
 *   storages/workspace.json                          归档/置顶清单、默认工作区路径
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

/** 合法时间戳(毫秒);坏数据返回 undefined,交给文件 mtime 兜底 */
function validTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface DshMeta {
	title?: string;
	lastPromptAt?: number;
}

function readMeta(json: unknown): DshMeta | undefined {
	const rows = (json as { record?: { rows?: Record<string, { val?: unknown }> } })?.record?.rows;
	if (!rows) return undefined;
	const rawTitle = rows.title?.val;
	const listMeta = rows.sessionListMetadata?.val as { lastPromptAt?: unknown } | undefined;
	// 坏数据只丢该字段,不丢整条会话
	return {
		title: typeof rawTitle === "string" ? rawTitle.trim() : undefined,
		lastPromptAt: validTime(listMeta?.lastPromptAt),
	};
}

interface WorkspaceInfo {
	archived: Set<string>;
	pinned: Set<string>;
	/** 默认工作区路径(decodeSlug 失败时的 cwd 兜底) */
	defaultPath?: string;
}

function idList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function readWorkspace(home: string): Promise<WorkspaceInfo> {
	try {
		const raw = JSON.parse(await readFile(join(home, "storages", "workspace.json"), "utf8")) as {
			global?: { archivedSessionIds?: unknown; pinnedSessionIds?: unknown; defaultWorkspaceId?: unknown };
			tables?: { workspaces?: Record<string, { path?: unknown }> };
		};
		const wsId = typeof raw.global?.defaultWorkspaceId === "string" ? raw.global.defaultWorkspaceId : undefined;
		const path = wsId ? raw.tables?.workspaces?.[wsId]?.path : undefined;
		return {
			archived: new Set(idList(raw.global?.archivedSessionIds)),
			pinned: new Set(idList(raw.global?.pinnedSessionIds)),
			defaultPath: typeof path === "string" && path.length > 0 ? path : undefined,
		};
	} catch {
		return { archived: new Set(), pinned: new Set() };
	}
}

export async function scanDshSessions(home: string = dshHome()): Promise<SessionRecord[]> {
	const metaDir = join(home, "storages", "session_projcache", "sessions");
	const sessionsRoot = join(home, "sessions");
	if (!existsSync(metaDir)) return [];
	const { archived, pinned, defaultPath } = await readWorkspace(home);

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
		const cwd = decodeSlug(slug) ?? defaultPath;
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
	// 3) 只有元数据、正文目录缺失的会话也要列出来(时间用元数据文件 mtime 兜底)
	for (const [id, entry] of metas) {
		if (seen.has(id)) continue;
		const at = (await stat(entry.file).catch(() => null))?.mtime ?? new Date(0);
		const title = entry.meta.title;
		records.push({
			tool: "dsh",
			id,
			file: "",
			metaFile: entry.file,
			cwd: defaultPath ?? "",
			name: title || undefined,
			named: false,
			topic: title || "(未命名会话)",
			firstMessage: title || "",
			createdAt: at,
			updatedAt: at,
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
	const lastPromptAt = entry?.meta.lastPromptAt;
	let size: number | undefined;
	let updated = lastPromptAt ? new Date(lastPromptAt) : undefined;
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
		// 与 zed/opencode 一致:标题是自动生成,不算“用户命名”
		named: false,
		topic: title || "(未命名会话)",
		firstMessage: title,
		createdAt: created ?? updated ?? new Date(0),
		updatedAt: updated ?? created ?? new Date(0),
		archived: archived.has(id),
		pinned: pinned.has(id),
		sizeBytes: size,
	};
}
