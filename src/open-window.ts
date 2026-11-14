/**
 * 打开会话:默认开一个新窗口(而不是把 CLI 托管在当前终端),窗口参数尽量与当前窗口一致。
 *
 * 三种落点由配置决定(见 open-config.ts):
 *   window = `wt -w new`(默认) · tab = `wt -w 0` 新标签 · attach = 就地接管(由调用方处理)
 *
 * 与当前窗口一致的三件事,分别来自不同来源:
 *   profile  ← 环境变量 WT_PROFILE_ID → Windows Terminal settings.json 里的名字
 *   尺寸/位置/最大化 ← 探测当前窗口(ConPTY 报列数行数,顶层窗口报屏幕坐标)
 *   环境变量 ← wt 在带 commandline 时默认 --inheritEnvironment
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ActionResult } from "./actions.ts";
import { probeConsoleGeometry, type ConsoleGeometry } from "./console-geometry.ts";
import { openInNewTerminal } from "./live/linux-focus.ts";
import type { SessionView } from "./model.ts";
import type { OpenConfig } from "./open-config.ts";
import { loadOpenConfig } from "./open-config.ts";
import { resumeCommand } from "./resume.ts";
import { resolveShell, shellArgs } from "./shell.ts";

const IS_WINDOWS = process.platform === "win32";

export interface WtArgsInput {
	mode: "window" | "tab";
	title: string;
	cwd: string;
	shell: string;
	shellArgs: string[];
	/** profile 名;空串表示让 WT 用它自己的默认 profile */
	profile: string;
	size: string | null;
	pos: string | null;
	maximized: boolean | null;
}

/** 拼 wt 的参数(纯函数,便于单测)。全局选项必须在子命令 `nt` 之前,否则 wt 会当成标签参数。 */
export function buildWtArgs(input: WtArgsInput): string[] {
	// 用 -1 而不是 new:某些 Windows Terminal 版本把 `new` 当成**窗口名**,
	// 第一次建一个叫 new 的窗口,之后的新标签全塞进它 —— 表现就是"永远开不出第二个窗口"。
	// -1 是文档里的"总是新窗口"保留值。
	const args = ["-w", input.mode === "window" ? "-1" : "0"];
	if (input.maximized === true) {
		args.push("--maximized");
	} else {
		if (input.size) args.push("--size", input.size);
		if (input.pos) args.push("--pos", input.pos);
	}
	args.push("nt");
	if (input.profile) args.push("--profile", input.profile);
	args.push("--title", input.title, "-d", input.cwd, input.shell, ...input.shellArgs);
	return args;
}

/** profile:配置里写了名字就用名字,否则继承当前窗口(探测到的) */
export function resolveProfile(config: OpenConfig, geometry: ConsoleGeometry | null): string {
	if (config.profile && config.profile !== "inherit") return config.profile;
	return geometry?.profile ?? "";
}

export interface GeometryArgs {
	size: string | null;
	pos: string | null;
	maximized: boolean | null;
}

/** `"120,30"` 这类值先过一遍格式校验:wt 拿到非法值会去启动一个同名程序,报 0x80070002 */
export function sanitizePair(value: string | null, min: number, max: number): string | null {
	if (!value) return null;
	const parts = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
	if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < min || n > max)) return null;
	return `${parts[0]},${parts[1]}`;
}

/** 尺寸/位置/最大化:配置显式值优先,其次继承当前窗口,探测失败就交给 WT 自己决定 */
export function resolveGeometry(config: OpenConfig, geometry: ConsoleGeometry | null): GeometryArgs {
	const inherit = config.geometry === "inherit" && geometry !== null;
	const probedSize = geometry && geometry.cols > 0 && geometry.rows > 0 ? `${geometry.cols},${geometry.rows}` : null;
	const probedPos = geometry && (geometry.x !== 0 || geometry.y !== 0) ? `${geometry.x},${geometry.y}` : null;
	return {
		size: sanitizePair(config.size ?? (inherit ? probedSize : null), 10, 500),
		pos: sanitizePair(config.pos ?? (inherit ? probedPos : null), -20000, 20000),
		maximized: config.maximized ?? (inherit ? (geometry?.maximized ?? null) : null),
	};
}

function sessionTitle(view: SessionView): string {
	return view.name?.trim() || view.topic?.trim() || view.id.slice(0, 8);
}

export interface OpenOptions {
	config?: OpenConfig;
	geometry?: ConsoleGeometry | null;
}

/** 按配置打开会话(window/tab)。attach 模式不在这里处理,交给 runAttach。 */
export async function openSession(view: SessionView, options: OpenOptions = {}): Promise<ActionResult> {
	const config = options.config ?? loadOpenConfig();
	const command = resumeCommand(view);
	if (!command) return { ok: false, detail: `暂不支持 ${view.tool} 的恢复命令` };
	const rawCwd = view.cwd && view.cwd.length > 0 ? view.cwd : process.cwd();
	const cwd = existsSync(rawCwd) ? rawCwd : process.cwd();
	const title = sessionTitle(view);
	const shell = resolveShell();
	// keepAlive 会给 bash 拼出 `; exec bash`、给 PowerShell 拼 `;` —— 而 Windows Terminal
	// 把 `;` 当作自己的命令分隔符(实测 `\;` 也拦不住),结果:前半截当标签命令执行、
	// 后半截被当成另一个命令 → 多出一个报错页,会话本身也没接着跑。
	const args = shellArgs(shell, command, { keepAlive: false }).command;
	const safeArgs = args.map((arg) => (arg.includes(";") ? arg.replaceAll(";", " &&") : arg));

	if (!IS_WINDOWS) {
		const opened = openInNewTerminal(`cd ${cwd.replace(/'/g, "'\\''")} && ${command}`, cwd);
		return opened.ok ? { ok: true, detail: `${opened.detail}: ${command}` } : opened;
	}

	const geometry = options.geometry === undefined ? await probeConsoleGeometry() : options.geometry;
	const profile = resolveProfile(config, geometry);
	const size = resolveGeometry(config, geometry);
	const mode: "window" | "tab" = config.mode === "tab" ? "tab" : "window";
	const wtArgs = buildWtArgs({ mode, title, cwd, shell, shellArgs: safeArgs, profile, ...size });
	try {
		const child = spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false });
		child.unref();
		const where = mode === "window" ? "新窗口" : "当前窗口新标签";
		const profileText = profile ? `profile=${profile}` : "WT 默认 profile";
		const sizeText = size.maximized ? "最大化" : [size.size && `${size.size} 列行`, size.pos && `位置 ${size.pos}`].filter(Boolean).join(" / ");
		return { ok: true, detail: `已在${where}启动(${profileText}${sizeText ? `,${sizeText}` : ""}): ${command}` };
	} catch (error) {
		return { ok: false, detail: `启动失败: ${error instanceof Error ? error.message : String(error)}` };
	}
}
