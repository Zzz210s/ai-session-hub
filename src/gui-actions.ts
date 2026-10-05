/**
 * GUI 会话动作:聚焦应用窗口 / 复制"去哪儿打开它"的说明。
 * 单独成文件:actions.ts 已接近 200 行上限。
 */

import type { ActionResult } from "./actions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { focusWindowLinux } from "./live/linux.ts";
import { focusWindow } from "./live/windows.ts";
import type { SessionView, Tool } from "./model.ts";

/** 聚焦某个 GUI 应用的窗口(从活体探测里找 hwnd;找不到就明确报错) */
export async function focusApp(tool: Tool): Promise<ActionResult> {
	const { probeLive } = await import("./live/probe.ts");
	const snapshot = await probeLive({ allowStale: true });
	const app = (snapshot.apps ?? []).find((item) => item.tool === tool);
	if (!app) return { ok: false, detail: `${tool} 没在运行(或没找到窗口)` };
	if (process.platform !== "win32") {
		const result = await focusWindowLinux(app.title);
		return { ok: result.ok, detail: result.detail };
	}
	if (!app.hwnd) return { ok: false, detail: `找到 ${tool} 进程,但没找到窗口句柄` };
	const result = await focusWindow(app.hwnd);
	return { ok: result.ok, detail: result.ok ? `已聚焦 ${tool} 窗口` : result.detail };
}

/** GUI 会话没有"恢复命令",复制的是"去哪儿打开它"的说明 */
export async function copySessionInfo(view: SessionView): Promise<ActionResult> {
	const lines = [
		`${view.tool} | ${view.name ?? view.topic}`,
		view.cwd ? `项目: ${view.cwd}` : "",
		view.metaFile ? `元数据: ${view.metaFile}` : "",
		view.file ? `存储: ${view.file}` : "",
		"打开方式:在应用内的会话列表里按标题查找(ais 无法直接打开指定会话)",
	].filter(Boolean);
	return copyToClipboard(lines.join("\n"));
}
