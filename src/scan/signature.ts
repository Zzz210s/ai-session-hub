/**
 * 会话存储的"结构指纹":用于判断**要不要重新扫描**。
 *
 * 判据只有"有没有新会话/会话消失"这一层:统计存储目录的 mtime(新增/删除文件会改目录 mtime)。
 * 不 stat 每个会话文件(那是扫描本身的开销,500 个文件约 200-300ms),也不看 opencode 数据库的 mtime
 * (它是共用库,写得频繁,会让指纹永远在变)。
 *
 * 两处例外:
 *   - Zed 改名只重写 threads.db 里的行,不新增/删除文件,所以库文件本身要进指纹;
 *   - DSH 的 projcache 目录里只有 *.json 文件(无子目录),只统计目录会恒为空,所以该目录要把文件也计入。
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

/** 指纹的来源路径(测试可只覆盖其中几项,指向临时目录) */
export interface SignatureSources {
	piSessions: string;
	claudeProjects: string;
	opencodeDb: string;
	zedDb: string;
	/** DSH 每会话一条 *.json 的元数据目录(文件也计入) */
	dshProjcache: string;
	dshSessions: string;
}

function defaultSources(): SignatureSources {
	return {
		piSessions: piSessionsRoot(),
		claudeProjects: claudeProjectsRoot(),
		opencodeDb: opencodeDbPath(),
		zedDb: zedThreadsDbPath(),
		dshProjcache: join(dshHome(), "storages", "session_projcache", "sessions"),
		dshSessions: join(dshHome(), "sessions"),
	};
}

/**
 * 目录指纹。默认只统计子目录(新增/删除会话会改目录 mtime)。
 * includeFiles 供"目录里只有文件"的存储使用(DSH projcache):此时文件大小与 mtime 一并计入,
 * 否则改写文件内容(如改标题)不会改父目录 mtime,指纹会漏掉这次变化。
 */
function dirSignature(root: string, includeFiles = false): string {
	try {
		const entries = readdirSync(root, { withFileTypes: true }).filter(
			(entry) => entry.isDirectory() || (includeFiles && entry.isFile()),
		);
		const parts = entries
			.map((entry) => {
				try {
					const info = statSync(join(root, entry.name));
					return entry.isFile() ? `${entry.name}:${info.size}:${info.mtimeMs}` : `${entry.name}:${info.mtimeMs}`;
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
		const info = statSync(file);
		return `${info.size}:${info.mtimeMs}`;
	} catch {
		return "missing";
	}
}

/** 各工具会话存储的结构指纹(便宜:只 readdir + 目录/库文件 stat) */
export function sessionSignature(override: Partial<SignatureSources> = {}): string {
	const sources = { ...defaultSources(), ...override };
	return [
		dirSignature(sources.piSessions),
		dirSignature(sources.claudeProjects),
		existsSignature(sources.opencodeDb),
		fileSignature(sources.zedDb),
		dirSignature(sources.dshProjcache, true),
		dirSignature(sources.dshSessions),
	].join(";");
}
