/**
 * 送入系统回收站(而非硬删除),并让用户能在文件管理器里还原。
 *
 * Windows:scripts/recycle.ps1(VisualBasic.FileIO + SendToRecycleBin)
 * Linux:按 freedesktop.org 规范写 ~/.local/share/Trash/{files,info}
 *   - files/<名字> 放文件本身;info/<名字>.trashinfo 记录原始路径与删除时间
 *   - 同名冲突时加 .1 .2 后缀(与规范一致)
 * 其它平台或失败时返回 ok:false,调用方退回内部回收目录。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "recycle.ps1");

export interface RecycleResult {
	ok: boolean;
	detail?: string;
}

/** 是否具备"系统回收站"能力 */
export function canRecycleToSystem(): boolean {
	if (process.platform === "win32") return existsSync(SCRIPT);
	if (process.platform === "linux") return existsSync("/proc/self/status");
	return false;
}

/* ---------- freedesktop 回收站 ---------- */

export function trashRoot(env: NodeJS.ProcessEnv = process.env): string {
	const dataHome = (env.XDG_DATA_HOME ?? "").trim();
	const base = dataHome.length > 0 ? dataHome : join(homedir(), ".local", "share");
	return join(base, "Trash");
}

/** 原始路径 → trashinfo 里的写法(规范:URL 编码,但保留 `/`) */
export function encodeTrashPath(path: string): string {
	// encodeURI 会保留 / : 等,这里再补上空格等字符的编码
	return encodeURI(path).replace(/#/g, "%23");
}

/**
 * 找一个不冲突的目标名:`foo.txt` → `foo.txt` / `foo.txt.1` / `foo.txt.2` …(规范做法)
 * exists 可注入,便于单测
 */
export function pickTrashName(name: string, exists: (candidate: string) => boolean): string {
	if (!exists(name)) return name;
	for (let index = 1; index < 1000; index++) {
		const candidate = `${name}.${index}`;
		if (!exists(candidate)) return candidate;
	}
	return `${name}.${Date.now()}`;
}

/**
 * Linux 回收站删除。任何一步失败都返回 ok:false(调用方会退回内部回收目录,不会真删)。
 * trashDir 可注入,便于用临时目录单测。
 */
export function recycleToTrashLinux(path: string, trashDir = trashRoot()): RecycleResult {
	try {
		const files = join(trashDir, "files");
		const info = join(trashDir, "info");
		mkdirSync(files, { recursive: true });
		mkdirSync(info, { recursive: true });
		const name = pickTrashName(basename(path), (candidate) => existsSync(join(files, candidate)) || existsSync(join(info, `${candidate}.trashinfo`)));
		const target = join(files, name);
		renameSync(path, target);
		const deletedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
		writeFileSync(
			join(info, `${name}.trashinfo`),
			`[Trash Info]\nPath=${encodeTrashPath(path)}\nDeletionDate=${deletedAt}\n`,
			"utf8",
		);
		return { ok: true, detail: `已移入回收站:${target}` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** 文件是否在被删除前就存在(给调用方判断用,避免误删) */
export function pathExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

export function recycleToSystem(path: string): Promise<RecycleResult> {
	if (process.platform === "linux") return Promise.resolve(recycleToTrashLinux(path));
	if (process.platform !== "win32") return Promise.resolve({ ok: false, detail: "当前平台没有系统回收站" });
	if (!existsSync(SCRIPT)) return Promise.resolve({ ok: false, detail: "缺少 scripts/recycle.ps1" });
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
