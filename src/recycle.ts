/**
 * 送入 Windows 回收站(而非硬删除)。
 *
 * 实现:调用 scripts/recycle.ps1,内部用
 * Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(..., SendToRecycleBin),
 * 由系统接管 —— 用户可在资源管理器里还原。
 * 非 Windows 或调用失败时返回 ok:false,由调用方退回内部回收目录。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "recycle.ps1");

export interface RecycleResult {
	ok: boolean;
	detail?: string;
}

/** 是否具备"系统回收站"能力(非 Windows 没有) */
export function canRecycleToSystem(): boolean {
	return process.platform === "win32" && existsSync(SCRIPT);
}

export function recycleToSystem(path: string): Promise<RecycleResult> {
	if (!canRecycleToSystem()) return Promise.resolve({ ok: false, detail: "当前平台没有系统回收站" });
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Path", path],
			{ windowsHide: true, timeout: 30_000 },
			(error, stdout, stderr) => {
				const out = (stdout ?? "").trim();
				if (out === "RECYCLED") {
					resolve({ ok: true });
					return;
				}
				resolve({ ok: false, detail: out || stderr?.trim() || error?.message || "回收站调用失败" });
			},
		);
	});
}
