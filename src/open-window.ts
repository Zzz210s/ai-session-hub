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
import { probeConsoleGeometry, profileNameFromEnv, type ConsoleGeometry } from "./console-geometry.ts";
import { openInNewTerminal } from "./live/linux-focus.ts";
import type { SessionView } from "./model.ts";
import type { OpenConfig } from "./open-config.ts";
import { loadOpenConfig } from "./open-config.ts";
import { resumeCommand } from "./resume.ts";
import { currentTab, currentTabCached } from "./live/current-tab.ts";
import { resolveShell, shellArgs, shellFlavor } from "./shell.ts";

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
	/**
	 * 开完标签后把焦点切回这一页(本页在窗口里的索引)。
	 * `wt new-tab` 一定会激活新标签,而 WT 还没有 `--no-focus`(microsoft/terminal#17460),
	 * 所以用同一次调用里的 `; focus-tab -t N` 兜回来。
	 */
	focusTabIndex?: number | null;
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
	// 新标签插在本页之后,本页索引不变 —— 所以开完直接切回同一个索引
	if (input.mode === "tab" && typeof input.focusTabIndex === "number" && input.focusTabIndex >= 0) {
		args.push(";", "focus-tab", "-t", String(input.focusTabIndex));
	}
	return args;
}

/** profile:配置里写了名字就用名字;否则先读 WT_PROFILE_ID(零成本、不会超时),再退回探测结果 */
export function resolveProfile(config: OpenConfig, geometry: ConsoleGeometry | null, envProfile = ""): string {
	if (config.profile && config.profile !== "inherit") return config.profile;
	return envProfile || geometry?.profile || "";
}

export interface GeometryArgs {
	size: string | null;
	pos: string | null;
	maximized: boolean | null;
	/**
	 * 开完标签后把焦点切回这一页(本页在窗口里的索引)。
	 * `wt new-tab` 一定会激活新标签,而 WT 还没有 `--no-focus`(microsoft/terminal#17460),
	 * 所以用同一次调用里的 `; focus-tab -t N` 兜回来。
	 */
	focusTabIndex?: number | null;
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
	/** 当前 WT profile 名(测试注入;默认从 WT_PROFILE_ID 读) */
	envProfile?: string;
	/** 本页在窗口里的索引(测试注入;默认探一次并缓存);null = 不切回焦点 */
	currentTabIndex?: number | null;
}

/** 按配置打开会话(window/tab)。attach 模式不在这里处理,交给 runAttach。 */
export async function openSession(view: SessionView, options: OpenOptions = {}): Promise<ActionResult> {
	const config = options.config ?? loadOpenConfig();
	const shell = resolveShell();
	// 引号要跟目标 shell 的语法一致:bash 用单引号,PowerShell 用单引号(cmd 只能用双引号)
	const command = resumeCommand(view, shellFlavor(shell));
	if (!command) return { ok: false, detail: `暂不支持 ${view.tool} 的恢复命令` };
	const rawCwd = view.cwd && view.cwd.length > 0 ? view.cwd : process.cwd();
	const cwd = existsSync(rawCwd) ? rawCwd : process.cwd();
	const title = sessionTitle(view);
	// keepAlive 会给 bash 拼出 `; exec bash`、给 PowerShell 拼 `;` —— 而 Windows Terminal
	// 把 `;` 当作自己的命令分隔符(实测 `\;` 也拦不住),结果:前半截当标签命令执行、
	// 后半截被当成另一个命令 → 多出一个报错页,会话本身也没接着跑。
	const args = shellArgs(shell, command, { keepAlive: false }).command;
	const safeArgs = args.map((arg) => (arg.includes(";") ? arg.replaceAll(";", " &&") : arg));

	if (!IS_WINDOWS) {
		const opened = openInNewTerminal(`cd ${cwd.replace(/'/g, "'\\''")} && ${command}`, cwd);
		return opened.ok ? { ok: true, detail: `${opened.detail}: ${command}` } : opened;
	}

	const mode: "window" | "tab" = config.mode === "window" ? "window" : "tab";
	// 标签模式下尺寸/位置根本用不上,别为了它们跑一次 powershell 探测(慢,还可能超时)
	const geometry = mode === "tab" ? null : options.geometry === undefined ? await probeConsoleGeometry() : options.geometry;
	const profile = resolveProfile(config, geometry, options.envProfile ?? profileNameFromEnv());
	const size = resolveGeometry(config, geometry);
	// 尺寸/位置/最大化只对新窗口有意义;往已有窗口加标签时传了会被忽略(个别版本还会报错)
	const geometryArgs = mode === "window" ? size : { size: null, pos: null, maximized: null };
	// 标签模式下开完要把焦点切回 ais 自己这一页,否则用户看到的是新会话页
	const keepFocus = mode === "tab" && config.keepFocus !== false;
	// 必须在**开之前**拿到本页索引:WT 的新标签插在哪儿取决于它的 newTabPosition 设置
	// (这台机器是"追加到末尾"),开完再算 k-1 会算错。本页索引不会因为开新标签而变。
	let focusTabIndex: number | null = null;
	if (keepFocus) {
		if (options.currentTabIndex !== undefined) {
			focusTabIndex = options.currentTabIndex;
		} else {
			// 必须**现探**:缓存是看板启动时的那一次,用户此后开关过标签页就会错位,
			// 而错位的后果就是 `focus-tab -t N` 把焦点切到**隔壁**标签 —— 用户看到的是
			// "打开后自己跳到下一个标签页"(2026-11-19 的报障)。
			// 但**必须限时**:这一步挡在"开标签"前面,探测慢(杀软/负载下实测 6-13 秒)时
			// 用户按 a 后什么都不发生。1.2 秒拿不到索引就算了,退回缓存 —— 宁可偶尔切错一页,
			// 也不要干等十几秒(2026-11-21 报障「会话启动太慢」)。
			const probe = await currentTab({ refresh: true, timeoutMs: 1200 }).catch(() => null);
			focusTabIndex = probe?.index ?? currentTabCached()?.index ?? null;
		}
	}
	const wtArgs = buildWtArgs({ mode, title, cwd, shell, shellArgs: safeArgs, profile, ...geometryArgs, focusTabIndex });
	try {
		const child = spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false });
		child.unref();
		const where = mode === "window" ? "新窗口" : "当前窗口新标签";
		const profileText = profile ? `profile=${profile}` : "WT 默认 profile";
		const sizeText =
			mode === "window"
				? geometryArgs.maximized
					? "最大化"
					: [geometryArgs.size && `${geometryArgs.size} 列行`, geometryArgs.pos && `位置 ${geometryArgs.pos}`].filter(Boolean).join(" / ")
				: "";
		return { ok: true, detail: `已在${where}启动(${profileText}${sizeText ? `,${sizeText}` : ""}): ${command}` };
	} catch (error) {
		return { ok: false, detail: `启动失败: ${error instanceof Error ? error.message : String(error)}` };
	}
}
