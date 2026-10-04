/**
 * 采集入口:汇总五个工具的会话存储
 */

import type { SessionRecord, Tool } from "../model.ts";
import { scanClaudeSessions } from "./claude.ts";
import { scanDshSessions } from "./dsh.ts";
import { scanOpenCodeSessions } from "./opencode.ts";
import { scanPiSessions } from "./pi.ts";
import { scanZedSessions } from "./zed.ts";

/** 会话存储位置覆盖(测试与扫描 worker 用;不传就用各家的默认位置) */
export interface ScanRoots {
	pi?: string;
	claude?: string;
	opencode?: string;
	zed?: string;
	dsh?: string;
}

export interface ScanOptions {
	tools?: Tool[];
	roots?: ScanRoots;
}

export async function scanAllSessions(options: ScanOptions = {}): Promise<SessionRecord[]> {
	const wanted = options.tools?.length ? new Set(options.tools) : null;
	const roots = options.roots ?? {};
	const scanners: { tool: Tool; scan: () => Promise<SessionRecord[]> }[] = [
		{ tool: "pi", scan: () => scanPiSessions(roots.pi) },
		{ tool: "claude", scan: () => scanClaudeSessions(roots.claude) },
		{ tool: "opencode", scan: () => scanOpenCodeSessions(roots.opencode) },
		{ tool: "zed", scan: () => scanZedSessions(roots.zed) },
		{ tool: "dsh", scan: () => scanDshSessions(roots.dsh) },
	];
	const results = await Promise.all(
		scanners.filter((entry) => !wanted || wanted.has(entry.tool)).map(async (entry) => {
			try {
				return await entry.scan();
			} catch {
				return [] as SessionRecord[];
			}
		}),
	);
	return results.flat().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export { scanClaudeSessions, scanDshSessions, scanOpenCodeSessions, scanPiSessions, scanZedSessions };
