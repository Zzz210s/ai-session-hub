/**
 * 会话存储的"结构指纹":用于判断**要不要重新扫描**。
 *
 * 判据只有"有没有新会话/会话消失"这一层:统计存储目录的 mtime(新增/删除文件会改目录 mtime)。
 * 不 stat 每个会话文件(那是扫描本身的开销,500 个文件约 200-300ms),也不看 opencode 数据库的 mtime
 * (它是共用库,写得频繁,会让指纹永远在变)。
 *
 * Zed 例外:改名只重写 threads.db 里的行,不新增/删除文件,所以库文件本身要进指纹
 * (比目录 mtime 更能反映"内容变了")。
 *
 * 于是:平时每 3 秒的刷新只需 ~10-25ms 就能确认"列表没变",不必重扫;真出现新会话时立刻重扫。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectsRoot } from "./claude.ts";
import { dshHome } from "./dsh.ts";
import { opencodeDbPath } from "./opencode.ts";
import { piSessionsRoot } from "./pi.ts";
import { zedThreadsDbPath } from "./zed.ts";

function dirSignature(root: string): string {
	try {
		const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		const parts = entries
			.map((entry) => {
				try {
					return `${entry.name}:${statSync(join(root, entry.name)).mtimeMs}`;
				} catch {
					return `${entry.name}:?`;
				}
			})
			.sort();
		return `${parts.length}[${parts.join(",")}]`;
	} catch {
		return "missing";
	}
}

function existsSignature(file: string): string {
	try {
		statSync(file);
		return "present";
	} catch {
		return "missing";
	}
}

function fileSignature(file: string): string {
	try {
		return `${statSync(file).size}:${statSync(file).mtimeMs}`;
	} catch {
		return "missing";
	}
}

/** 各工具会话存储的结构指纹(便宜:只 readdir + 目录/库文件 stat) */
export function sessionSignature(): string {
	return [
		dirSignature(piSessionsRoot()),
		dirSignature(claudeProjectsRoot()),
		existsSignature(opencodeDbPath()),
		fileSignature(zedThreadsDbPath()),
		dirSignature(join(dshHome(), "storages", "session_projcache", "sessions")),
		dirSignature(join(dshHome(), "sessions")),
	].join(";");
}
