/**
 * 进程命令行 → 是哪个 CLI 的会话(跨平台共用)。
 *
 * 判定靠命令行特征,不靠可执行文件名:各家 CLI 的启动方式五花八门
 * (node 脚本、npm shim、bun、原生二进制),而命令行里一定会带包名或入口路径。
 */

import type { Tool } from "../model.ts";

export interface Classified {
	tool: Tool;
	/** 内部子进程(如 pi 的 --mode json 子代理),不算独立会话 */
	internal: boolean;
}

export function classifyProcess(cmd: string): Classified | null {
	const lower = cmd.toLowerCase();
	if (lower.includes("pi-coding-agent")) {
		// 子代理以 --mode json 运行,不算独立会话
		const internal = /--mode\s+json/.test(lower);
		return { tool: "pi", internal };
	}
	if (lower.includes("@anthropic-ai") || lower.includes("claude-code")) {
		return { tool: "claude", internal: false };
	}
	if (/[\\/]opencode|opencode-ai/.test(lower)) {
		return { tool: "opencode", internal: false };
	}
	return null;
}
