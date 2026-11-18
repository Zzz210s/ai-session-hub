/**
 * 当前进程所在的 Windows Terminal 标签页是哪一个。
 *
 * 为什么要知道:`wt new-tab` 一定会把焦点切到新标签(WT 还没有 `--no-focus`,
 * microsoft/terminal#17460 仍开着),而用户希望 ais 开完会话后**留在 ais 这一页**。
 * 唯一的办法是开完立刻 `focus-tab -t <本页索引>`。
 *
 * 探测要跑一次 PowerShell + UIA(实测约 2 秒),所以在进程内缓存:
 * 新标签是插在当前页之后的,本页索引不会因为开新标签而变化。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePowerShellEngine } from "./windows.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "current-tab.ps1");

export interface CurrentTab {
	windowPid: number;
	index: number;
	title: string;
}

/** 缓存:同一进程里只探一次(除非探测失败或调用方要求刷新) */
let cached: CurrentTab | null | undefined;
let inflight: Promise<CurrentTab | null> | null = null;

export function resetCurrentTab(): void {
	cached = undefined;
	inflight = null;
}

export function probeCurrentTabUncached(): Promise<CurrentTab | null> {
	if (process.platform !== "win32" || !existsSync(SCRIPT)) return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(
			resolvePowerShellEngine(),
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
			{ windowsHide: true, timeout: 20_000 },
			(error, stdout) => {
				const text = (stdout ?? "").trim();
				if (error || !text || text === "null") return resolve(null);
				try {
					const raw = JSON.parse(text) as { windowPid?: number; index?: number; title?: string };
					if (typeof raw.index !== "number" || Number.isNaN(raw.index)) return resolve(null);
					resolve({ windowPid: Number(raw.windowPid ?? 0), index: raw.index, title: String(raw.title ?? "") });
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/** 取当前标签(带缓存);探测失败时缓存 null,避免每次打开都白等两秒 */
export function currentTab(options: { refresh?: boolean } = {}): Promise<CurrentTab | null> {
	if (process.platform !== "win32") return Promise.resolve(null);
	if (!options.refresh && cached !== undefined) return Promise.resolve(cached);
	if (inflight) return inflight;
	inflight = probeCurrentTabUncached().then((result) => {
		cached = result;
		inflight = null;
		return result;
	});
	return inflight;
}

/** 同步读缓存(不触发探测):TUI 启动时预热过就能立刻拿到 */
export function currentTabCached(): CurrentTab | null {
	return cached ?? null;
}

/** 启动时预热,让第一次打开会话不用等这两秒 */
export function warmCurrentTab(): void {
	if (process.platform !== "win32") return;
	void currentTab();
}
