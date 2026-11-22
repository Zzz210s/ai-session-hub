/**
 * 动作:聚焦已有终端标签 / 复制恢复命令 / 就地接管终端(打开新窗口见 open-window.ts)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { SessionView } from "./model.ts";
import { copyToClipboard } from "./clipboard.ts";
import { describeFocusFailure, focusApp } from "./gui-actions.ts";
import { focusTab, focusWindow } from "./live/windows.ts";
import { focusWindowLinux } from "./live/linux-focus.ts";
import { cliAvailable, resumeCommand } from "./resume.ts";
import { resolveShell, shellArgs } from "./shell.ts";

export { resumeCommand } from "./resume.ts";

export { copySessionInfo, focusApp } from "./gui-actions.ts";
export { copyToClipboard } from "./clipboard.ts";

const IS_WINDOWS = process.platform === "win32";

export interface ActionResult {
	ok: boolean;
	detail: string;
}

/** 聚焦该会话已运行的终端窗口 */
export async function focusSession(view: SessionView): Promise<ActionResult> {
	// GUI 会话(zed/dsh)没有终端窗口,直接聚焦应用窗口;否则会回“没有可定位的终端窗口”这种误导文案
	if (view.kind === "gui") return focusApp(view.tool);
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
		return { ok: result.ok, detail: result.ok ? `已聚焦窗口 pid ${tab.windowPid} 的第 ${tab.index + 1} 个标签` : describeFocusFailure(view.tool, result.detail) };
	}
	// 非 Windows Terminal:按控制台窗口句柄聚焦(conhost / Windows PowerShell 控制台)
	const consoleWindow = view.live?.console;
	if (consoleWindow) {
		const result = await focusWindow(consoleWindow.hwnd);
		return { ok: result.ok, detail: result.ok ? `已聚焦控制台窗口(pid ${consoleWindow.pid})` : describeFocusFailure(view.tool, result.detail) };
	}
	return { ok: false, detail: "该会话没有可定位的终端窗口(未运行或标题不匹配)" };
}

/** 复制恢复命令到系统剪贴板(行为与文案不变,剪贴板写入见 clipboard.ts) */
export async function copyResumeCommand(view: SessionView): Promise<ActionResult> {
	const command = resumeCommand(view);
	if (!command) return { ok: false, detail: `暂不支持 ${view.tool}` };
	const result = await copyToClipboard(command);
	// 本机没装也照抄 —— 命令本身还有用(贴到装了它的环境里跑),只是要说明白
	return result.ok && !cliAvailable(view.tool) ? { ok: true, detail: `${result.detail}(注意:本机没找到 ${view.tool} 可执行文件)` } : result;
}

/** 在本进程前台接管终端运行该会话(供 TUI 的 attach 模式使用),返回退出码。
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
