/**
 * GUI 会话动作:聚焦应用窗口 / 复制"去哪儿打开它"的说明。
 * 单独成文件:actions.ts 已接近 200 行上限。
 */

import type { ActionResult } from "./actions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { focusWindowLinux } from "./live/linux-focus.ts";
import { probeLive } from "./live/probe.ts";
import { focusWindow } from "./live/windows.ts";
import { guiLabel, type SessionView, type Tool } from "./model.ts";

/** 聚焦脚本 / wmctrl 的失败码 → 用户可读的中文说明(裸英文码不进提示行) */
export function describeFocusFailure(tool: Tool, detail: string): string {
	const label = guiLabel(tool);
	switch (detail.trim()) {
		case "FOCUS_FAILED":
			return `无法把 ${label} 窗口切到前台(Windows 前台锁),可先点一下窗口再试`;
		case "WINDOW_NOT_FOUND":
			return `没找到 ${label} 的窗口,可能刚关闭或标题变了(按 r 刷新后重试)`;
		case "BAD_HWND":
			return `${label} 的窗口句柄无效(窗口可能刚关闭),按 r 刷新后重试`;
		case "":
			return `聚焦 ${label} 失败,脚本没有返回原因`;
		default:
			return `聚焦 ${label} 失败:${detail.trim()}`;
	}
}

/** focusApp 的可注入依赖(测试用;默认走真实现) */
export interface FocusAppDeps {
	probe: typeof probeLive;
	focusWindows: (hwnd: string) => Promise<{ ok: boolean; detail: string }>;
	focusLinux: (title: string, hwnd?: string) => Promise<{ ok: boolean; detail: string }>;
	platform: NodeJS.Platform;
}

/** 聚焦某个 GUI 应用的窗口(从活体探测里找 hwnd;找不到就明确报错) */
export async function focusApp(tool: Tool, overrides: Partial<FocusAppDeps> = {}): Promise<ActionResult> {
	const deps: FocusAppDeps = { probe: probeLive, focusWindows: focusWindow, focusLinux: focusWindowLinux, platform: process.platform, ...overrides };
	const label = guiLabel(tool);
	const snapshot = await deps.probe({ allowStale: true });
	const app = (snapshot.apps ?? []).find((item) => item.tool === tool);
	if (!app) return { ok: false, detail: `${label} 没在运行(或没找到窗口)` };
	if (deps.platform !== "win32") {
		// Linux:优先用枚举到的 hwnd(wmctrl -i -a),没有句柄才回退按标题
		const result = await deps.focusLinux(app.title, app.hwnd);
		return { ok: result.ok, detail: result.ok ? `已聚焦 ${label} 窗口` : describeFocusFailure(tool, result.detail) };
	}
	if (!app.hwnd) return { ok: false, detail: `找到 ${label} 进程,但没找到窗口句柄(按 r 刷新后重试)` };
	const result = await deps.focusWindows(app.hwnd);
	return { ok: result.ok, detail: result.ok ? `已聚焦 ${label} 窗口` : describeFocusFailure(tool, result.detail) };
}

/** GUI 会话没有"恢复命令",复制的是"去哪儿打开它"的说明 */
export async function copySessionInfo(view: SessionView): Promise<ActionResult> {
	const lines = [
		`${guiLabel(view.tool)} | ${view.name ?? view.topic}`,
		view.cwd ? `项目: ${view.cwd}` : "",
		view.metaFile ? `元数据: ${view.metaFile}` : "",
		view.file ? `存储: ${view.file}` : "",
		"打开方式:在应用内的会话列表里按标题查找(ais 无法直接打开指定会话)",
	].filter(Boolean);
	return copyToClipboard(lines.join("\n"));
}
