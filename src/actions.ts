/**
 * 动作:聚焦已有终端标签 / 在新标签恢复会话 / 复制恢复命令
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionView } from "./model.ts";
import { copyToClipboard } from "./clipboard.ts";
import { focusTab, focusWindow } from "./live/windows.ts";
import { focusWindowLinux, openInNewTerminal } from "./live/linux-focus.ts";
import { resolveShell, shellArgs } from "./shell.ts";

export { copySessionInfo, focusApp } from "./gui-actions.ts";
export { copyToClipboard } from "./clipboard.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * 解析 CLI 可执行文件的绝对路径。
 * 必要性:WT 新标签里启动的 bash 继承的 PATH 可能不含 pnpm/npm 全局 bin,
 * 直接用 `pi` 会 "command not found"(表现为标签一闪而过)。
 */
function resolveCliCommand(tool: SessionView["tool"]): string {
	// 显式覆盖优先(AIS_PI_BIN / AIS_CLAUDE_BIN)
	const override = tool === "pi" ? process.env.AIS_PI_BIN : tool === "claude" ? process.env.AIS_CLAUDE_BIN : undefined;
	if (override && existsSync(override)) return override.replace(/\\/g, "/");
	if (!IS_WINDOWS) {
		// 类 Unix:各 CLI 的入口就在 PATH 上(pnpm/npm/bun 的 shim 都是可执行脚本)
		const fromPathUnix = (process.env.PATH ?? "")
			.split(":")
			.map((dir) => (dir ? `${dir}/${tool}` : ""))
			.filter((candidate) => candidate.length > 0)
			.find((candidate) => {
				try {
					return existsSync(candidate);
				} catch {
					return false;
				}
			});
		return fromPathUnix ?? tool;
	}
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	// PATH 上能跑到的也算候选(用户 shell 实际用的那个)
	const fromPath = (process.env.PATH ?? "")
		.split(process.platform === "win32" ? ";" : ":")
		.flatMap((dir) => (dir ? [`${dir}/${tool}`, `${dir}/${tool}.cmd`, `${dir}/${tool}.CMD`] : []))
		.filter((candidate) => {
			try {
				return existsSync(candidate);
			} catch {
				return false;
			}
		});
	const candidates: Record<string, string[]> = {
		// 先看新版 pnpm 布局(pnpm 10+: <local>/pnpm/bin),旧 shim 指向 global/5(旧版本),
		// 曾经导致 ais 拉起的会话一直跑旧 pi + 旧扩展集
		pi: [
			join(local, "pnpm", "bin", "pi"),
			join(local, "pnpm", "bin", "pi.CMD"),
			...fromPath,
			join(local, "pnpm", "pi"),
			join(local, "pnpm", "pi.CMD"),
		],
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

export interface ActionResult {
	ok: boolean;
	detail: string;
}

/** 聚焦该会话已运行的终端窗口 */
export async function focusSession(view: SessionView): Promise<ActionResult> {
	if (!IS_WINDOWS) {
		// Linux:按会话名找窗口(wmctrl / xdotool),名字来自 /name 或心跳
		const needle = view.name?.trim() || view.topic?.trim() || "";
		const result = await focusWindowLinux(needle);
		return { ok: result.ok, detail: result.detail };
	}
	const tab = view.live?.tab;
	if (tab) {
		if (tab.index < 0) return { ok: false, detail: "该窗口未枚举到标签页" };
		const result = await focusTab(tab);
		return { ok: result.ok, detail: result.ok ? `已聚焦窗口 pid ${tab.windowPid} 的第 ${tab.index + 1} 个标签` : `聚焦失败: ${result.detail}` };
	}
	// 非 Windows Terminal:按控制台窗口句柄聚焦(conhost / Windows PowerShell 控制台)
	const consoleWindow = view.live?.console;
	if (consoleWindow) {
		const result = await focusWindow(consoleWindow.hwnd);
		return { ok: result.ok, detail: result.ok ? `已聚焦控制台窗口(pid ${consoleWindow.pid})` : `聚焦失败: ${result.detail}` };
	}
	return { ok: false, detail: "该会话没有可定位的终端窗口(未运行或标题不匹配)" };
}

/** 在新标签/新窗口里恢复该会话 */
export function resumeInNewTab(view: SessionView): ActionResult {
	const command = resumeCommand(view);
	if (!command) return { ok: false, detail: `暂不支持 ${view.tool} 的恢复命令` };
	const cwd = view.cwd && view.cwd.length > 0 ? view.cwd : process.cwd();
	const title = view.name?.trim() || view.topic?.trim() || view.id.slice(0, 8);
	if (!IS_WINDOWS) {
		// Linux:优先 tmux 新窗口,其次 $TERMINAL / x-terminal-emulator(同步起,失败由 spawn 报错)
		const opened = openInNewTerminal(`cd ${shellQuote(cwd)} && ${command}`, cwd);
		return opened.ok ? { ok: true, detail: `${opened.detail}: ${command}` } : opened;
	}
	try {
		// wt 的两条硬规则:
		//   1) 尾部命令必须是"程序 + 参数"(wt 不经 shell 执行,不能只给一串命令)
		//   2) wt 用 ";" 分隔自己的多条命令,故命令串内不能出现分号
		// shell 由适配层决定(Git Bash / PowerShell),参数形态随之不同
		const shell = resolveShell();
		const args = shellArgs(shell, command, { keepAlive: true }).command;
		const child = spawn("wt.exe", ["-w", "0", "nt", "--title", title, "-d", cwd, shell, ...args], {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		});
		child.unref();
		return {
			ok: true,
			detail: `已在新标签启动: ${command}
提示: 若新标签一闪而过或报错(Windows Terminal 的命令行解析/默认 profile 差异),用 ais 选择器按 c 复制命令后手动粘贴即可`,
		};
	} catch (error) {
		return { ok: false, detail: `启动失败: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** 复制恢复命令到系统剪贴板(行为与文案不变,剪贴板写入见 clipboard.ts) */
export function copyResumeCommand(view: SessionView): ActionResult {
	const command = resumeCommand(view);
	if (!command) return { ok: false, detail: `暂不支持 ${view.tool}` };
	return copyToClipboard(command);
}

/** 供 shell 里安全地嵌入一个路径 */
function shellQuote(value: string): string {
	return IS_WINDOWS ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

/** 智能默认动作:运行中优先聚焦,否则新窗口/新标签恢复 */
export async function smartAction(view: SessionView): Promise<ActionResult> {
	if (view.state === "running" && (view.live?.tab || !IS_WINDOWS)) return focusSession(view);
	return resumeInNewTab(view);
}

/**
 * 在本进程前台接管终端运行该会话(供 TUI 的 attach 模式使用),返回退出码。
 * 由本进程托管 PTY/子进程,不依赖终端自身对命令行的解析。
 */
export function attachSession(view: SessionView): Promise<number> {
	const command = resumeCommand(view);
	const cwd = view.cwd && existsSync(view.cwd) ? view.cwd : process.cwd();
	// 用用户自己的 shell 承载命令(Git Bash 或 PowerShell),退出后保持交互
	const shell = resolveShell();
	const args = shellArgs(shell, command, { keepAlive: true }).command;
	return new Promise((resolve) => {
		const child = spawn(shell, args, { stdio: "inherit", cwd, windowsHide: false });
		child.on("exit", (code) => resolve(code ?? 0));
		child.on("error", () => resolve(-1));
	});
}
