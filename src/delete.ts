/**
 * 删除会话:把会话从工具的历史里移除。
 *
 * 安全设计(这是破坏性操作):
 *   1. 只允许删除"未在运行"的会话 —— 运行中的会话文件正被写入,删除会损坏它
 *   2. 不做硬删除:文件型会话移入回收目录 ~/.ai-session-hub/trash/,可恢复
 *   3. 同时清理该会话残留的心跳记录,避免留下"幽灵运行中"状态
 *   4. opencode 的会话存于 SQLite(与其它会话共用同一 .db),暂不支持删除
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { SessionView } from "./model.ts";
import { liveDir } from "./live/heartbeat.ts";
import { canRecycleToSystem, recycleToSystem, type RecycleResult } from "./recycle.ts";
import { title } from "./format.ts";

export interface DeletePlan {
	/** 是否可删除 */
	supported: boolean;
	/** 不可删除时的原因(直接展示给用户) */
	reason?: string;
	/** 会话文件路径 */
	path?: string;
	/** 需要一并清理的心跳记录文件 */
	heartbeatFiles?: string[];
	/** 删除方式:recycle = 系统回收站,trash = 内部回收目录 */
	mode?: "recycle" | "trash" | "db";
}

export function trashDir(): string {
	return join(homedir(), ".ai-session-hub", "trash");
}

export interface DeleteOptions {
	/** 内部回收目录(系统回收站不可用时的退路;默认 ~/.ai-session-hub/trash) */
	trashDir?: string;
	/** 心跳注册表目录(默认 ~/.ai-sessions/live;单测注入临时目录) */
	liveDirectory?: string;
	/** 送入系统回收站的方式(默认 Windows 回收站;单测注入假实现) */
	recycle?: (path: string) => Promise<RecycleResult>;
	/** 是否允许使用系统回收站(默认按平台判断) */
	allowSystemRecycle?: boolean;
}

/** 找出该会话残留的心跳记录(按 sessionId 匹配) */
async function heartbeatFilesFor(view: SessionView, dir = liveDir()): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as { sessionId?: string; tool?: string };
			if (raw.sessionId === view.id && (!raw.tool || raw.tool === view.tool)) found.push(join(dir, name));
		} catch {
			/* 跳过损坏的记录 */
		}
	}
	return found;
}

/**
 * 规划删除(纯判定,不触碰文件系统之外的副作用)。
 * 展示原因、路径,并交给用户确认后才执行。
 */
export async function planDelete(view: SessionView, options: DeleteOptions = {}): Promise<DeletePlan> {
	if (view.state === "running") {
		return { supported: false, reason: "会话正在运行:请先聚焦该窗口(f)并退出会话,再删除" };
	}
	if (view.tool === "opencode") {
		return { supported: false, reason: "opencode 的会话存于 SQLite(与其它会话共用同一库),暂不支持删除" };
	}
	if (!view.file || !existsSync(view.file)) {
		return { supported: false, reason: `会话文件不存在: ${view.file || "(空)"}` };
	}
	return {
		supported: true,
		mode: (options.allowSystemRecycle ?? canRecycleToSystem()) ? "recycle" : "trash",
		path: view.file,
		heartbeatFiles: await heartbeatFilesFor(view, options.liveDirectory ?? liveDir()),
	};
}

export interface DeleteResult {
	ok: boolean;
	detail: string;
}

/** 执行删除:移入回收目录并清理心跳 */
export async function deleteSession(view: SessionView, options: DeleteOptions = {}): Promise<DeleteResult> {
	const plan = await planDelete(view, options);
	if (!plan.supported || !plan.path) return { ok: false, detail: plan.reason ?? "不可删除" };

	// 1) 优先送系统回收站(用户可在资源管理器里还原)
	const useSystem = options.allowSystemRecycle ?? canRecycleToSystem();
	let how = "";
	let fallbackNote = "";
	if (useSystem) {
		const recycle = options.recycle ?? recycleToSystem;
		const result = await recycle(plan.path);
		if (result.ok) {
			how = "已放入系统回收站(可在资源管理器还原)";
		} else {
			fallbackNote = `(系统回收站不可用:${result.detail ?? "未知原因"})`;
		}
	}

	// 2) 退路:移入内部回收目录(同样可恢复)
	if (!how) {
		const dir = options.trashDir ?? trashDir();
		await mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const target = join(dir, `${stamp}__${view.tool}__${basename(plan.path)}`);
		try {
			await rename(plan.path, target);
		} catch (error) {
			return { ok: false, detail: `移入回收目录失败: ${error instanceof Error ? error.message : String(error)}` };
		}
		how = `移入回收目录 ${dir}${fallbackNote}`;
	}

	let cleaned = 0;
	for (const file of plan.heartbeatFiles ?? []) {
		try {
			await unlink(file);
			cleaned++;
		} catch {
			/* 忽略 */
		}
	}
	const heartbeatNote = cleaned > 0 ? `,并清理 ${cleaned} 条心跳记录` : "";
	return { ok: true, detail: `已删除「${title(view)}」:${how}${heartbeatNote}` };
}
