/**
 * 恢复命令的拼装:各 CLI 的入口路径 + 会话参数。
 *
 * 单独成模块的原因:新窗口/新标签/就地接管三条路都要同一份命令,
 * 放在 actions.ts 里会和"打开方式"互相 import(循环)。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionView } from "./model.ts";
import { shellFlavor, type ShellFlavor } from "./shell.ts";

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
/**
 * 按目标 shell 的语法给参数加引号。
 *
 * 为什么不用双引号:命令串会被 Windows Terminal 再序列化一遍交给子进程。实测把
 * `node dump.mjs --session "C:\Users\..."` 经 `wt ... bash -lc` 跑,双引号里所有
 * 反斜杠都被吃掉 —— `C:\Users\23652\.pi\...` 变成 `C:Users23652.pi...`,于是 pi
 * 打开的是一个"盘符相对路径",报 EPERM/ENOENT。单引号版本原样送达。
 */
export function quoteForShell(value: string, flavor: ShellFlavor = "bash"): string {
	if (flavor === "cmd") return `"${value}"`;
	if (flavor === "powershell") return `'${value.replaceAll("'", "''")}'`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function resumeCommand(view: SessionView, flavor: ShellFlavor = "bash"): string {
	switch (view.tool) {
		case "pi":
			// 缺会话文件时不能拼出 --session "undefined":那样会在新窗口里报错,还看不出原因
			return view.file ? `${quoteForShell(resolveCliCommand("pi"), flavor)} --session ${quoteForShell(view.file, flavor)}` : "";
		case "claude":
			return `${quoteForShell(resolveCliCommand("claude"), flavor)} --resume ${view.id}`;
		case "opencode":
			return `${quoteForShell(resolveCliCommand("opencode"), flavor)} --session ${view.id}`;
		default:
			return "";
	}
}
