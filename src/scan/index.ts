/**
 * 采集入口:汇总三个 CLI 的会话存储
 */

import type { SessionRecord, Tool } from "../model.ts";
import { scanClaudeSessions } from "./claude.ts";
import { scanOpenCodeSessions } from "./opencode.ts";
import { scanPiSessions } from "./pi.ts";

export interface ScanOptions {
	tools?: Tool[];
}

const SCANNERS: { tool: Tool; scan: () => Promise<SessionRecord[]> }[] = [
	{ tool: "pi", scan: scanPiSessions },
	{ tool: "claude", scan: scanClaudeSessions },
	{ tool: "opencode", scan: scanOpenCodeSessions },
];

export async function scanAllSessions(options: ScanOptions = {}): Promise<SessionRecord[]> {
	const wanted = options.tools?.length ? new Set(options.tools) : null;
	const results = await Promise.all(
		SCANNERS.filter((entry) => !wanted || wanted.has(entry.tool)).map(async (entry) => {
			try {
				return await entry.scan();
			} catch {
				return [] as SessionRecord[];
			}
		}),
	);
	return results.flat().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export { scanClaudeSessions, scanOpenCodeSessions, scanPiSessions };
