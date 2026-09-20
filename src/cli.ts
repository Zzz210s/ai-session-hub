#!/usr/bin/env node
/**
 * ais — AI 会话总览与跳转 CLI
 *
 *   ais                  交互式选择器(运行中优先聚焦已有标签,否则新标签恢复)
 *   ais list [--json]    列表输出
 *   ais doctor           探测诊断(各工具会话数、活体进程、终端标签、心跳)
 *   ais focus <查询>     聚焦匹配到的运行中会话
 *   ais resume <查询>    在新标签恢复匹配到的会话
 */

// node:sqlite 仍是实验特性,屏蔽这一条噪音警告(其它警告照常显示)。
// 必须先移除 Node 内置的 warning 监听,否则默认打印仍会输出。
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (!/SQLite is an experimental feature/.test(String(warning.message ?? ""))) {
		console.warn(`(${warning.name}) ${warning.message}`);
	}
});

import type { SessionView, Tool } from "./model.ts";
import { loadViews } from "./hub.ts";
import { formatRow, summarize, title } from "./format.ts";
import { rankByQuery } from "./fuzzy.ts";
import { resolveShell, shellFlavor, shellPromptLabel } from "./shell.ts";
import { configuredExtensions } from "./extensions.ts";
import { focusSession, resumeInNewTab } from "./actions.ts";
import { runTui } from "./tui.ts";

interface Args {
	command: string;
	query: string;
	json: boolean;
	limit: number;
	noLive: boolean;
	tools?: Tool[];
	liveOnly: boolean;
}

const TOOLS: Tool[] = ["pi", "claude", "opencode"];

export function parseArgs(argv: string[]): Args {
	const args: Args = { command: "", query: "", json: false, limit: 40, noLive: false, liveOnly: false };
	const rest: string[] = [];
	for (const token of argv) {
		if (token === "--json") args.json = true;
		else if (token === "--no-live") args.noLive = true;
		else if (token === "--live") args.liveOnly = true;
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

export function toJson(views: SessionView[]): string {
	return JSON.stringify(
		views.map((view) => ({
			tool: view.tool,
			id: view.id,
			name: view.name,
			topic: view.topic,
			cwd: view.cwd,
			state: view.state,
			status: view.status,
			attention: view.attention,
			pid: view.live?.pid ?? view.live?.heartbeat?.pid,
			tab: view.live?.tab ? { windowPid: view.live.tab.windowPid, index: view.live.tab.index, title: view.live.tab.title } : undefined,
			sessionFile: view.file,
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt.toISOString(),
			sizeBytes: view.sizeBytes,
		})),
		null,
		2,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { views, live, heartbeatCount } = await loadViews({ tools: args.tools, noLive: args.noLive });

	if (args.command === "doctor") {
		const summary = summarize(views);
		console.log("== AI 会话探测诊断 ==");
		console.log(`会话总数: ${summary.total}(运行中 ${summary.running},需关注 ${summary.attention})`);
		for (const [tool, count] of Object.entries(summary.byTool)) console.log(`  ${tool.padEnd(10)} ${count}`);
		console.log(`活体进程: ${live.processes.length}(${live.processes.map((p) => `${p.tool}#${p.pid}`).join(", ") || "-"})`);
		console.log(`终端标签: ${live.tabs.length}`);
		for (const tab of live.tabs) console.log(`  [${tab.index}]${tab.selected ? "*" : " "} ${tab.title}`);
		console.log(`心跳记录: ${heartbeatCount}`);
		const extensionList = configuredExtensions();
		console.log(`拓展: ${extensionList.length ? extensionList.join(", ") : "(无 —— 核心单独运行)"}`);
		console.log(`控制台窗口: ${live.consoleWindows.length}(非 Windows Terminal 的兜底聚焦)`);
		const shell = resolveShell();
		console.log(`本机 shell: ${shell}(${shellFlavor(shell)} / ${shellPromptLabel(shell)})`);
		console.log("接管/分屏都用该 shell;可用 AIS_SHELL 覆盖(例如 AIS_SHELL=powershell.exe)");
		if (live.error) console.log(`探测错误: ${live.error}`);
		return;
	}

	let list = views;
	if (args.liveOnly) list = list.filter((view) => view.state === "running");
	if (args.query && (args.command === "focus" || args.command === "resume")) {
		list = rankByQuery(list, args.query, (view) => `${title(view)} ${view.cwd} ${view.tool} ${view.id}`, 500);
	}

	if (args.command === "focus" || args.command === "resume") {
		const target = list[0];
		if (!target) {
			console.error("未找到匹配的会话");
			process.exitCode = 1;
			return;
		}
		const result = args.command === "focus" ? await focusSession(target) : resumeInNewTab(target);
		console.log(`${result.ok ? "OK" : "FAIL"} ${title(target)}: ${result.detail}`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (args.command === "list" || (!process.stdin.isTTY && !args.command)) {
		if (args.json) {
			console.log(toJson(list.slice(0, args.limit)));
			return;
		}
		const summary = summarize(views);
		console.log(`AI 会话 ${summary.total} 个(运行中 ${summary.running}) — 显示 ${Math.min(list.length, args.limit)} 条`);
		for (const view of list.slice(0, args.limit)) console.log(formatRow(view));
		return;
	}

	if (args.command && args.command !== "tui") {
		console.error(`未知命令: ${args.command}\n用法: ais [list|doctor|focus <查询>|resume <查询>] [--json] [--live] [--tool=pi,claude,opencode]`);
		process.exitCode = 2;
		return;
	}

	await runTui({
		load: async () => (await loadViews({ tools: args.tools })).views,
		filter: args.liveOnly ? "running" : "all",
	});
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
