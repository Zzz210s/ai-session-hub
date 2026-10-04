#!/usr/bin/env node
/**
 * ais — AI 会话总览与跳转 CLI
 *
 *   ais                  交互式选择器(运行中优先聚焦已有标签,否则新标签恢复)
 *   ais list [--json]    列表输出
 *   ais doctor           探测诊断(各工具会话数、活体进程、终端标签、心跳)
 *   ais focus <查询>     聚焦匹配到的运行中会话
 *   ais resume <查询>    在新标签恢复匹配到的会话
 *   ais delete <查询>    删除会话(默认只预览;--yes 执行,移入回收目录可恢复)
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
import { sweepHeartbeats } from "./live/heartbeat.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printDoctor } from "./doctor.ts";
import { parseArgs } from "./args.ts";
import { focusSession, resumeInNewTab } from "./actions.ts";
import { runTui } from "./tui.ts";
import { deleteSession, planDelete, trashDir } from "./delete.ts";
import { flushScanCache } from "./scan/cache.ts";

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

/** 版本号来自 package.json(单一真源) */
export function readVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "version") {
		console.log(`ais ${readVersion()} (${process.platform}/${process.arch}, node ${process.version})`);
		return;
	}
	// --fast:接受 ≤60 秒的旧实况快照,不等真探测(通常 0.4-0.6 秒出结果);--no-live 则完全不探测
	const { views, live, heartbeatCount } = await loadViews({
		tools: args.tools,
		noLive: args.noLive,
		noCache: args.noCache,
		staleLive: args.fast,
		liveStaleMs: args.fast ? 60_000 : undefined,
	});

	if (args.command === "doctor") {
		await printDoctor({ views, live, heartbeatCount });
		return;
	}

	let list = views;
	if (args.liveOnly) list = list.filter((view) => view.state === "running");
	if (args.query && (args.command === "focus" || args.command === "resume")) {
		list = rankByQuery(list, args.query, (view) => `${title(view)} ${view.cwd} ${view.tool} ${view.id}`, 500);
	}

	if (args.command === "gc") {
		const result = await sweepHeartbeats({ dryRun: !args.yes });
		const staleList = result.stale.length > 9 ? `${result.stale.slice(0, 9).join(", ")} …` : result.stale.join(", ");
		if (result.stale.length === 0) {
			console.log(`心跳注册表干净:共 ${result.total} 个文件,没有可清理的`);
			return;
		}
		if (!args.yes) {
			console.log(`可清理 ${result.stale.length} / ${result.total} 个心跳文件(失效记录:进程已死且超 24 小时,或超 7 天):`);
			console.log(`  ${staleList}`);
			console.log("确认后请加 --yes 重新执行");
			return;
		}
		console.log(`OK 已清理 ${result.removed} / ${result.total} 个心跳文件:${staleList}`);
		return;
	}

	if (args.command === "delete") {
		const target = args.query ? rankByQuery(list, args.query, (view) => `${title(view)} ${view.cwd} ${view.tool} ${view.id}`, 500)[0] : undefined;
		if (!target) {
			console.error("用法: ais delete <查询> [--yes]  —— 默认只预览,加 --yes 才真正删除(移入回收目录)");
			process.exitCode = 1;
			return;
		}
		const plan = await planDelete(target);
		if (!plan.supported) {
			console.error(`FAIL ${title(target)}: ${plan.reason}`);
			process.exitCode = 1;
			return;
		}
		if (!args.yes) {
			console.log(`将删除「${title(target)}」(${target.tool})`);
			for (const item of plan.paths ?? (plan.path ? [plan.path] : [])) console.log(`  文件: ${item}`);
			console.log(`  去向: ${trashDir()}(可恢复)`);
			console.log("确认后请加 --yes 重新执行");
			return;
		}
		const result = await deleteSession(target);
		console.log(`${result.ok ? "OK" : "FAIL"} ${title(target)}: ${result.detail}`);
		process.exitCode = result.ok ? 0 : 1;
		return;
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
		console.log(`AI 会话 ${summary.total} 个(运行中 ${summary.running}) — 显示 ${Math.min(list.length, args.limit)} 条${args.fast ? "(快速模式:实况可能滞后 ≤60 秒)" : ""}`);
		for (const view of list.slice(0, args.limit)) console.log(formatRow(view));
		return;
	}

	if (args.command && args.command !== "tui") {
		console.error(`未知命令: ${args.command}\n用法: ais [list|doctor|focus <查询>|resume <查询>] [--json] [--live] [--tool=pi,claude,opencode]`);
		process.exitCode = 2;
		return;
	}

	const pre = await import("./preflight-run.ts")
		.then((m) => m.startPreflight({ disabled: args.noUpdate }))
		.catch(() => undefined);
	if (pre) console.log(pre);
	await runTui({
		load: async (options) =>
			(await loadViews({ tools: args.tools, liveTtlMs: options?.liveTtlMs, staleLive: options?.staleLive, staleSessions: options?.staleSessions, neverBlockLive: options?.neverBlockLive, neverBlockSessions: options?.neverBlockSessions })).views,
		filter: args.liveOnly ? "running" : "all",
	});
}

main()
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	// 扫描缓存落盘:命令结束后统一 flush(exit 钩子里的异步写不可靠)
	.finally(() => flushScanCache());
