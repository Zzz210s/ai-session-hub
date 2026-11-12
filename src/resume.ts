/**
 * 恢复命令的拼装:各 CLI 的入口路径 + 会话参数。
 *
 * 单独成模块的原因:新窗口/新标签/就地接管三条路都要同一份命令,
 * 放在 actions.ts 里会和"打开方式"互相 import(循环)。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionView } from "./model.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * 解析 CLI 可执行文件的绝对路径。
 * 必要性:WT 新标签里启动的 shell 继承的 PATH 可能不含 pnpm/npm 全局 bin,
 * 直接用 `pi` 会 "command not found"(表现为标签一闪而过)。
 */
export function resolveCliCommand(tool: SessionView["tool"]): string {
	// 显式覆盖优先(AIS_PI_BIN / AIS_CLAUDE_BIN)
	const override = tool === "pi" ? process.env.AIS_PI_BIN : tool === "claude" ? process.env.AIS_CLAUDE_BIN : undefined;
	if (override && existsSync(override)) return override.replace(/\\/g, "/");
	const pathDirs = (process.env.PATH ?? "").split(IS_WINDOWS ? ";" : ":").filter((dir) => dir.length > 0);
	const fromPath = pathDirs
		.flatMap((dir) => (IS_WINDOWS ? [`${dir}/${tool}`, `${dir}/${tool}.cmd`, `${dir}/${tool}.CMD`] : [`${dir}/${tool}`]))
		.filter((candidate) => {
			try {
				return existsSync(candidate);
			} catch {
				return false;
			}
		});
	if (!IS_WINDOWS) return fromPath[0] ?? tool;
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	const candidates: Record<string, string[]> = {
		// 先看新版 pnpm 布局(pnpm 10+: <local>/pnpm/bin),旧 shim 指向 global/5(旧版本),
		// 曾经导致 ais 拉起的会话一直跑旧 pi + 旧扩展集
		pi: [join(local, "pnpm", "bin", "pi"), join(local, "pnpm", "bin", "pi.CMD"), ...fromPath, join(local, "pnpm", "pi"), join(local, "pnpm", "pi.CMD")],
		claude: [join(roaming, "npm", "claude"), join(roaming, "npm", "claude.CMD"), ...fromPath, join(local, "pnpm", "claude")],
		opencode: [join(local, "pnpm", "bin", "opencode"), join(local, "pnpm", "bin", "opencode.CMD"), ...fromPath, join(local, "pnpm", "opencode.CMD")],
	};
	for (const candidate of candidates[tool] ?? []) {
		try {
			if (existsSync(candidate)) return candidate.replace(/\\/g, "/");
		} catch {
			/* 继续 */
		}
	}
	return tool;
}

/** 各 CLI 的恢复命令(基于会话存储位置或会话 id) */
export function resumeCommand(view: SessionView): string {
	switch (view.tool) {
		case "pi":
			return `${resolveCliCommand("pi")} --session "${view.file}"`;
		case "claude":
			return `${resolveCliCommand("claude")} --resume ${view.id}`;
		case "opencode":
			return `${resolveCliCommand("opencode")} --session ${view.id}`;
		default:
			return "";
	}
}
