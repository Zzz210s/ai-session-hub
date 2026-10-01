/**
 * 命令行参数解析(纯函数,单独成模块便于单测;cli.ts 只做执行)。
 */

import type { Tool } from "./model.ts";

export interface Args {
	command: string;
	query: string;
	json: boolean;
	limit: number;
	noLive: boolean;
	tools?: Tool[];
	liveOnly: boolean;
	/** delete 命令需显式 --yes 才真正删除(默认只预览) */
	yes: boolean;
	/** 绕过缓存(强制重新探测) */
	noCache: boolean;
	/** 跳过启动前自更新(等价 AIS_NO_UPDATE=1) */
	noUpdate: boolean;
	/** 快速模式:实况允许用≤ 60 秒的旧快照,不等真探测 */
	fast: boolean;
}

export const TOOLS: Tool[] = ["pi", "claude", "opencode"];

export function parseArgs(argv: string[]): Args {
	const args: Args = { command: "", query: "", json: false, limit: 40, noLive: false, liveOnly: false, yes: false, noCache: false, noUpdate: false, fast: false };
	const rest: string[] = [];
	for (const token of argv) {
		if (token === "--json") args.json = true;
		else if (token === "--no-live") args.noLive = true;
		else if (token === "--fast") args.fast = true;
		else if (token === "--live") args.liveOnly = true;
		else if (token === "--no-update" || token === "--skip-update") args.noUpdate = true;
		else if (token === "--yes" || token === "-y") args.yes = true;
		else if (token === "--no-cache") args.noCache = true;
		else if (token.startsWith("--limit")) args.limit = Number(token.split("=")[1] ?? 40) || 40;
		else if (token.startsWith("--tool=")) {
			const list = token
				.split("=")[1]
				.split(",")
				.map((t) => t.trim())
				.filter((t): t is Tool => (TOOLS as string[]).includes(t));
			if (list.length) args.tools = list;
		} else if (!args.command) args.command = token;
		else rest.push(token);
	}
	args.query = rest.join(" ");
	return args;
}
