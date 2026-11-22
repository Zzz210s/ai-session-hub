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
	// 显式覆盖优先(AIS_PI_BIN / AIS_CLAUDE_BIN / AIS_OPENCODE_BIN)
	const override = cliOverride(tool);
	if (override && existsSync(override)) return override.replace(/\\/g, "/");
	const fromPath = pathCandidates(tool);
	if (!IS_WINDOWS) return fromPath[0] ?? tool;
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	const home = process.env.USERPROFILE ?? "";
	const candidates: Record<string, string[]> = {
		// 先看新版 pnpm 布局(pnpm 10+: <local>/pnpm/bin),旧 shim 指向 global/5(旧版本),
		// 曾经导致 ais 拉起的会话一直跑旧 pi + 旧扩展集
		pi: [join(local, "pnpm", "bin", "pi.CMD"), join(local, "pnpm", "bin", "pi.exe"), ...fromPath, join(local, "pnpm", "pi.CMD")],
		claude: [join(roaming, "npm", "claude.CMD"), join(roaming, "npm", "claude.exe"), ...fromPath, join(local, "pnpm", "claude.CMD")],
		// opencode:官方安装器落 ~/.opencode/bin(pnpm/npm 只在用包管理器装时才有),
		// 还有 scoop / bun / winget 三种常见来源 —— 少列一处就是"命令跑不起来"
		opencode: [
			join(home, ".opencode", "bin", "opencode.exe"),
			join(home, ".opencode", "bin", "opencode"),
			join(home, ".bun", "bin", "opencode.exe"),
			join(home, "scoop", "shims", "opencode.exe"),
			join(local, "Programs", "opencode", "opencode.exe"),
			join(local, "Microsoft", "WinGet", "Links", "opencode.exe"),
			join(local, "pnpm", "bin", "opencode.CMD"),
			join(local, "pnpm", "bin", "opencode.exe"),
			...fromPath,
			join(home, ".local", "bin", "opencode"),
			join(local, "pnpm", "opencode.CMD"),
		],
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

function cliOverride(tool: SessionView["tool"]): string | undefined {
	const key = `AIS_${tool.toUpperCase()}_BIN`;
	return (process.env[key] ?? "").trim() || undefined;
}

/** PATH 里的候选:Windows 上要认 .exe(原生安装器)/ .cmd / .CMD 三种 */
function pathCandidates(tool: string): string[] {
	const dirs = (process.env.PATH ?? "").split(IS_WINDOWS ? ";" : ":").filter((dir) => dir.length > 0);
	const suffixes = IS_WINDOWS ? ["", ".cmd", ".CMD", ".exe", ".EXE"] : [""];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const suffix of suffixes) {
			const candidate = `${dir.replace(/[\\/]$/, "")}/${tool}${suffix}`;
			try {
				if (existsSync(candidate)) out.push(candidate);
			} catch {
				/* 该目录不可读,跳过 */
			}
		}
	}
	return out;
}

/**
 * 这个工具在本机装没装。
 *
 * 为什么要问:会话可能来自另一台机器 / 另一个环境(用户在 WSL 里用过 opencode),
 * 会话数据还在、可执行文件却没了。这时开新标签只会得到 `command not found`(退出码 127)
 * 和一个死窗口 —— 2026-11-22 的报障就是这个。
 */
export function cliAvailable(tool: SessionView["tool"]): boolean {
	const command = resolveCliCommand(tool);
	return command.includes("/") || command.includes("\\") ? existsSync(command) : false;
}

/** 会话数据的常见位置(给"没找到可执行文件"的提示用,说明"数据还在") */
const STORAGE_HINT: Partial<Record<SessionView["tool"], string>> = {
	pi: "~/.pi/agent/sessions",
	claude: "~/.claude/projects",
	opencode: "~/.local/share/opencode",
};

/**
 * 没装时给用户的说法:不掩盖、不猜、给出可复制的出路。
 * 刻意**不**自动安装任何东西 —— 装什么、装到哪由用户决定。
 */
export function missingCliMessage(tool: SessionView["tool"]): string {
	const storage = STORAGE_HINT[tool] ? `(会话数据还在 ${STORAGE_HINT[tool]})` : "";
	const override = `AIS_${tool.toUpperCase()}_BIN=<路径>`;
	return `没找到 ${tool} 可执行文件${storage}:装好 ${tool} 后可继续;装在别处可用 ${override} 指过来;要用已有的会话数据也可按 C 复制命令到已装它的环境执行`;
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
