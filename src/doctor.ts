/**
 * `ais doctor` 的输出:各工具会话数、活体进程、终端标签、心跳、shell、拓展。
 *
 * 单独成模块的原因:这段是"只读诊断的排版",与命令分发无关,放在 cli.ts 里会把主流程挤到
 * 200 行以上(用户的硬要求);抽出来后两者都更好读。
 */

import { summarize } from "./format.ts";
import { configuredExtensions } from "./extensions.ts";
import { countHeartbeats } from "./live/heartbeat.ts";
import { hasCommand } from "./live/exec.ts";
import { canRecycleToSystem } from "./recycle.ts";
import { resolveShell, shellFlavor, shellPromptLabel } from "./shell.ts";
import { describeToolColors } from "./theme.ts";
import type { LiveSnapshot } from "./live/windows.ts";
import type { LiveApp, SessionView } from "./model.ts";

export interface DoctorInput {
	views: SessionView[];
	live: LiveSnapshot;
	heartbeatCount: number;
}

/** 打印诊断信息(只读,不修改任何状态) */
export async function printDoctor({ views, live, heartbeatCount }: DoctorInput): Promise<void> {
	const summary = summarize(views);
	console.log("== AI 会话探测诊断 ==");
	console.log(`会话总数: ${summary.total}(运行中 ${summary.running},需关注 ${summary.attention})`);
	for (const [tool, count] of Object.entries(summary.byTool)) console.log(`  ${tool.padEnd(10)} ${count}`);
	console.log(`活体进程: ${live.processes.length}(${live.processes.map((p) => `${p.tool}#${p.pid}`).join(", ") || "-"})`);
	console.log(`终端标签: ${live.tabs.length}`);
	for (const tab of live.tabs) console.log(`  [${tab.index}]${tab.selected ? "*" : " "} ${tab.title}`);
	// apps 由任务 7 的探测侧填充;缺失时显示 -
	const apps = (live as LiveSnapshot & { apps?: LiveApp[] }).apps ?? [];
	console.log(`GUI 应用窗口: ${apps.map((app) => `${app.tool}#${app.pid}`).join(", ") || "-"}`);
	const registry = await countHeartbeats();
	console.log(`心跳记录: ${heartbeatCount} 条有效 / 目录共 ${registry} 个文件${registry > heartbeatCount ? `(可清理 ${registry - heartbeatCount} 条:ais gc --yes)` : ""}`);
	console.log(`工具配色(256 色): ${describeToolColors()}(可用 NO_COLOR / AIS_COLOR=0 关闭)`);
	const extensionList = configuredExtensions();
	console.log(`拓展: ${extensionList.length ? extensionList.join(", ") : "(无 —— 核心单独运行)"}`);
	console.log(
		`平台: ${process.platform}${process.platform === "win32" ? "(实况探测用 PowerShell + UI Automation)" : "(实况探测用 ps;窗口聚焦需 wmctrl 或 xdotool)"}`,
	);
	if (process.platform === "win32") console.log(`控制台窗口: ${live.consoleWindows.length}(非 Windows Terminal 的兜底聚焦)`);
	const shell = resolveShell();
	console.log(`本机 shell: ${shell}(${shellFlavor(shell)} / ${shellPromptLabel(shell)})`);
	console.log("接管/分屏都用该 shell;可用 AIS_SHELL 覆盖");
	if (process.platform !== "win32") {
		const focusTools = [(await hasCommand("wmctrl")) ? "wmctrl" : "", (await hasCommand("xdotool")) ? "xdotool" : ""].filter(Boolean);
		console.log(`窗口聚焦工具: ${focusTools.length ? focusTools.join(" / ") : "缺少(装 wmctrl 或 xdotool 后可用)"}`);
		console.log(`回收站: ${canRecycleToSystem() ? "freedesktop(~/.local/share/Trash)" : "内部回收目录"}(删除的会话可在文件管理器还原)`);
	}
	if (live.error) console.log(`探测错误: ${live.error}`);
}
