/**
 * 删除会话:把会话从工具的历史里移除。
 *
 * 安全设计(这是破坏性操作):
 *   1. 只允许删除"未在运行"的会话 —— 运行中的会话文件正被写入,删除会损坏它
 *   2. 不做硬删除:文件型会话移入回收目录 ~/.ai-session-hub/trash/,可恢复
 *   3. 同时清理该会话残留的心跳记录,避免留下"幽灵运行中"状态
 *   4. opencode 的会话存于 SQLite(与其它会话共用同一 .db),暂不支持删除
 *   5. Zed 的线程也存于 SQLite(整个 threads.db),禁用删除(设计 §3.4)
 *   6. DSH 的会话目录与 session_projcache 元数据条目一起移走,避免应用留悬挂条目
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
	/** 会话文件路径(保留兼容;多文件会话见 paths) */
	path?: string;
	/** 需要一并移走的全部路径(DSH:会话目录 + 元数据条目) */
	paths?: string[];
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

/** 组装多路径删除计划(DSH 与普通会话共用:模式判定 + 心跳收集) */
async function planForPaths(view: SessionView, paths: string[], options: DeleteOptions): Promise<DeletePlan> {
	return {
		supported: true,
		mode: (options.allowSystemRecycle ?? canRecycleToSystem()) ? "recycle" : "trash",
		paths,
		path: paths[0],
		heartbeatFiles: await heartbeatFilesFor(view, options.liveDirectory ?? liveDir()),
	};
}

/** 把移动失败原因说清楚(跨盘 rename 会返回裸 EXDEV) */
function describeMoveError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "EXDEV" || /EXDEV/.test(message)) return `跨盘移动失败(回收目录与源文件不在同一磁盘):${message}`;
	return message;
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
	if (view.tool === "zed") {
		return { supported: false, reason: "Zed 的线程存于 SQLite(改行有损坏应用数据的风险),请在 Zed 内删除" };
	}
	if (view.tool === "dsh") {
		// 会话目录与 session_projcache 元数据要一起移走,否则应用里会留悬挂条目(设计 §3.4)
		const paths = [view.file, view.metaFile].filter((item): item is string => Boolean(item) && existsSync(item));
		if (paths.length === 0) return { supported: false, reason: "会话目录与元数据都不存在,无需删除" };
		return planForPaths(view, paths, options);
	}
	if (!view.file || !existsSync(view.file)) {
		return { supported: false, reason: `会话文件不存在: ${view.file || "(空)"}` };
	}
	return planForPaths(view, [view.file], options);
}

export interface DeleteResult {
	ok: boolean;
	detail: string;
}

/** 执行删除:把 plan 给出的每个路径移入回收目录,并清理心跳 */
export async function deleteSession(view: SessionView, options: DeleteOptions = {}): Promise<DeleteResult> {
	const plan = await planDelete(view, options);
	if (!plan.supported) return { ok: false, detail: plan.reason ?? "不可删除" };
	const paths = plan.paths ?? (plan.path ? [plan.path] : []);
	// 兜底:计划理应有路径,空计划说明规划逻辑有 bug,不能当成成功
	if (paths.length === 0) return { ok: false, detail: "删除计划里没有可移动的路径" };

	// 逐个处理:优先送系统回收站(Windows:资源管理器;Linux:freedesktop 回收站)
	const useSystem = options.allowSystemRecycle ?? canRecycleToSystem();
	const recycle = options.recycle ?? recycleToSystem;
	const dir = options.trashDir ?? trashDir();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let recycled = 0;
	let moved = 0;
	const failed: { name: string; reason: string }[] = [];
	let fallbackNote = "";
	for (const source of paths) {
		const name = basename(source);
		if (useSystem) {
			const result = await recycle(source);
			if (result.ok) {
				recycled++;
				continue;
			}
			fallbackNote = `(系统回收站不可用:${result.detail ?? "未知原因"})`;
		}
		// 退路:移入内部回收目录(同样可恢复);mkdir 也放进 try,失败不能变成 unhandled rejection
		try {
			await mkdir(dir, { recursive: true });
			let target = join(dir, `${stamp}__${view.tool}__${name}`);
			let n = 2;
			while (existsSync(target)) target = join(dir, `${stamp}__${view.tool}__${name}-${n++}`);
			await rename(source, target);
			moved++;
		} catch (error) {
			failed.push({ name, reason: describeMoveError(error) });
		}
	}

	const done = recycled + moved;
	const parts: string[] = [];
	if (recycled > 0) {
		parts.push(`${recycled} 项已放入${process.platform === "win32" ? "系统回收站(可在资源管理器还原)" : "回收站(可在文件管理器还原)"}`);
	}
	if (moved > 0) parts.push(`${moved} 项已移入回收目录 ${dir}${fallbackNote}`);
	if (failed.length > 0) parts.push(`${failed.length} 项失败(${failed.map((item) => `${item.name}: ${item.reason}`).join("; ")})`);

	// 只有全部路径都移走才算成功;部分成功会让应用留悬挂条目(设计 §3.4)
	if (done < paths.length) {
		// moved>0 时 fallbackNote 已随“已移入回收目录”展示;这里只在未展示时补上
		const note = fallbackNote && moved === 0 ? ` ${fallbackNote}` : "";
		return { ok: false, detail: `已删除「${title(view)}」失败:成功 ${done} 项 / 失败 ${failed.length} 项${parts.length > 0 ? `(${parts.join(";")})` : ""}${note}` };
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
	return { ok: true, detail: `已删除「${title(view)}」:${parts.join(";")}${heartbeatNote}` };
}
