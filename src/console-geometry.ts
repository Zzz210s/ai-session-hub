/**
 * 探测当前控制台的几何(列/行/位置/最大化)与 Windows Terminal profile 名。
 *
 * 为什么要探测:用户要求新窗口"和本窗口完全一致",而 Windows Terminal 的命令行参数
 * 只能"指定"尺寸位置,不能"读取当前值" —— 只有从进程自身问得到:
 *   - 列数/行数:ConPTY 会把窗格大小报给 CONOUT$,`[Console]::WindowWidth` 在输出被重定向时是 0
 *   - 位置/最大化:属于 WindowsTerminal.exe 的顶层窗口,沿父进程链往上找
 *   - profile:WT 给每个子进程导出 WT_PROFILE_ID(GUID),拿它去 settings.json 里换名字
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ConsoleGeometry {
	cols: number;
	rows: number;
	x: number;
	y: number;
	width: number;
	height: number;
	maximized: boolean;
	/** Windows Terminal profile 名;不在 WT 里跑或解析失败时为空串 */
	profile: string;
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "console-geometry.ps1");

/** 把脚本的一行 JSON 解析成结构;坏数据当探测失败(null),别让配置解析拖垮打开会话 */
export function parseGeometry(raw: string): ConsoleGeometry | null {
	const line = raw
		.split(/\r?\n/)
		.map((part) => part.trim())
		.filter((part) => part.startsWith("{"))
		.pop();
	if (!line) return null;
	try {
		const parsed = JSON.parse(line) as Partial<ConsoleGeometry> & { profileB64?: string };
		const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
		// profile 名走 base64:PowerShell 5.1 按控制台代码页(CP936)写 stdout,中文名直接读会变乱码
		const profile = typeof parsed.profileB64 === "string" && parsed.profileB64.length > 0
			? Buffer.from(parsed.profileB64, "base64").toString("utf8")
			: typeof parsed.profile === "string" ? parsed.profile : "";
		return {
			cols: num(parsed.cols),
			rows: num(parsed.rows),
			x: num(parsed.x),
			y: num(parsed.y),
			width: num(parsed.width),
			height: num(parsed.height),
			maximized: parsed.maximized === true,
			profile,
		};
	} catch {
		return null;
	}
}


/**
 * 从环境变量直接解出当前 Windows Terminal profile 名。
 *
 * 为什么不靠 PowerShell 探测:探测要跑一次 powershell(几百毫秒到几秒,还可能超时),
 * 一旦失败 profile 就是空串 —— 于是新标签落到 WT 的**默认 profile**(用户看到的就是
 * "在 Cmder 里按 a,开出来却是 PowerShell")。而 WT_PROFILE_ID 永远在环境里,读它零成本。
 */
export function profileNameFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
	const guid = (env.WT_PROFILE_ID ?? "").trim().toLowerCase();
	if (!guid) return "";
	const local = env.LOCALAPPDATA ?? "";
	const candidates: string[] = [];
	if (local) {
		candidates.push(join(local, "Microsoft", "Windows Terminal", "settings.json"));
		const packages = join(local, "Packages");
		try {
			for (const entry of readdirSync(packages)) {
				if (!/^Microsoft\.WindowsTerminal/i.test(entry)) continue;
				candidates.push(join(packages, entry, "LocalState", "settings.json"));
			}
		} catch {
			/* 没有 Packages 目录就只看经典路径 */
		}
	}
	for (const path of candidates) {
		let raw: string;
		try {
			raw = readFile(path);
		} catch {
			continue;
		}
		try {
			// WT 的 settings.json 带 BOM,JSON.parse 不认
			const settings = JSON.parse(raw.replace(/^﻿/, "")) as { profiles?: { list?: Array<{ guid?: string; name?: string }> } };
			const list = settings.profiles?.list ?? [];
			const hit = list.find((item) => (item.guid ?? "").toLowerCase() === guid);
			if (hit?.name) return hit.name;
		} catch {
			continue;
		}
	}
	return "";
}

let cached: ConsoleGeometry | null | undefined;

/** 每个进程只探一次(几何在同一秒内不会变,重复探只会拖慢打开速度) */
export async function probeConsoleGeometry(options: { force?: boolean } = {}): Promise<ConsoleGeometry | null> {
	if (process.platform !== "win32") return null;
	if (!options.force && cached !== undefined) return cached;
	cached = await new Promise<ConsoleGeometry | null>((resolve) => {
		if (!existsSync(SCRIPT)) return resolve(null);
		const powershell = process.env.AIS_PWSH?.trim() || "powershell.exe";
		execFile(
			powershell,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
			{ timeout: 5000, windowsHide: true },
			(error, stdout) => resolve(error ? null : parseGeometry(stdout)),
		);
	});
	return cached;
}

/** 测试用:清掉缓存 */
export function resetGeometryCache(): void {
	cached = undefined;
}
