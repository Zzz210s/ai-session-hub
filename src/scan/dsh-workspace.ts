/**
 * DSH 工作区清单与项目 slug 编码(从 scan/dsh.ts 拆出)。
 *
 * cwd 的权威来源是 `~/.dsh/storages/workspace.json` 的 `tables.workspaces[].path`:
 * 会话目录名是路径的**有损**编码(分隔符与连字符都写成 `-`),反解会让
 * `deepseek-harness` 变成 `deepseek/harness`。所以先按编码后的 slug 精确匹配清单,
 * 匹配不到才退回 decodeSlug + 默认工作区。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceInfo {
	archived: Set<string>;
	pinned: Set<string>;
	/** 默认工作区路径(decodeSlug 失败时的 cwd 兜底) */
	defaultPath?: string;
	/** DSH 编码后的项目 slug -> 权威工作区路径 */
	paths: Map<string, string>;
}

function idList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * 按 DSH 规则把工作区路径编码成会话目录名:
 * 连续的路径分隔符(`:` `\` `/`)折叠成一个 `-`(如 `C:\Users` -> `C-Users`),
 * 路径自带的连字符保持原样,整串再包一层 `--`。
 * 例:`C:\Users\me\deepseek-harness\ws` -> `--C-Users-me-deepseek-harness-ws--`
 */
export function encodeSlug(path: string): string | undefined {
	const trimmed = path.trim();
	if (trimmed.length === 0) return undefined;
	return `--${trimmed.replace(/[:\\/]+/g, "-")}--`;
}

export async function readWorkspace(home: string): Promise<WorkspaceInfo> {
	try {
		const raw = JSON.parse(await readFile(join(home, "storages", "workspace.json"), "utf8")) as {
			global?: { archivedSessionIds?: unknown; pinnedSessionIds?: unknown; defaultWorkspaceId?: unknown };
			tables?: { workspaces?: Record<string, { path?: unknown }> };
		};
		const workspaces = raw.tables?.workspaces ?? {};
		const paths = new Map<string, string>();
		for (const ws of Object.values(workspaces)) {
			if (typeof ws?.path !== "string" || ws.path.length === 0) continue;
			const slug = encodeSlug(ws.path);
			if (slug) paths.set(slug, ws.path);
		}
		const wsId = typeof raw.global?.defaultWorkspaceId === "string" ? raw.global.defaultWorkspaceId : undefined;
		const defaultRaw = wsId ? workspaces[wsId]?.path : undefined;
		return {
			archived: new Set(idList(raw.global?.archivedSessionIds)),
			pinned: new Set(idList(raw.global?.pinnedSessionIds)),
			defaultPath: typeof defaultRaw === "string" && defaultRaw.length > 0 ? defaultRaw : undefined,
			paths,
		};
	} catch {
		return { archived: new Set(), pinned: new Set(), paths: new Map() };
	}
}
