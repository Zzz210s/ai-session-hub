/**
 * Linux 窗口聚焦与新开终端(wmctrl / xdotool / tmux)。
 * 独立成文件:这些动作只依赖 run/hasCommand,和 ps 解析不是一回事。
 */

import { spawn } from "node:child_process";
import { hasCommand, run } from "./exec.ts";

/** wmctrl 按窗口句柄激活的参数(比回喂标题可靠:标题可能被应用改写) */
export function wmctrlActivateArgs(hwnd: string): string[] {
	return ["-i", "-a", hwnd];
}

/**
 * Linux 聚焦:优先用枚举到的 hwnd(`wmctrl -i -a`,精确),没有句柄时回退按标题匹配
 * (wmctrl / xdotool 取第一个命中的窗口)。
 */
export async function focusWindowLinux(title: string, hwnd?: string): Promise<{ ok: boolean; detail: string }> {
	const needle = title.trim();
	const handle = (hwnd ?? "").trim();
	if (!needle && !handle) return { ok: false, detail: "没有可匹配的窗口标题(会话名/心跳缺失)" };

	if (await hasCommand("wmctrl")) {
		if (handle) {
			const activated = await run("wmctrl", wmctrlActivateArgs(handle));
			return activated.ok ? { ok: true, detail: `已聚焦窗口(${handle})` } : { ok: false, detail: `wmctrl 无法激活窗口 ${handle}` };
		}
		const activated = await run("wmctrl", ["-a", needle]);
		if (activated.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		const listed = await run("wmctrl", ["-l"]);
		const hit = listed.out.split(/\r?\n/).find((line) => line.includes(needle));
		const id = hit?.trim().split(/\s+/)[0];
		if (id) {
			const byId = await run("wmctrl", ["-i", "-a", id]);
			if (byId.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		}
		return { ok: false, detail: `wmctrl 没找到标题含「${needle}」的窗口` };
	}

	if (await hasCommand("xdotool")) {
		const search = await run("xdotool", ["search", "--name", needle]);
		const id = search.out.split(/\r?\n/).find((line) => line.trim());
		if (id) {
			const activated = await run("xdotool", ["windowactivate", id.trim()]);
			if (activated.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		}
		if (handle) {
			const activated = await run("xdotool", ["windowactivate", handle]);
			if (activated.ok) return { ok: true, detail: `已聚焦窗口(${handle})` };
		}
		return { ok: false, detail: `xdotool 没找到标题含「${needle}」的窗口` };
	}

	return { ok: false, detail: "Linux 下聚焦窗口需要 wmctrl 或 xdotool(装一个即可)" };
}

/**
 * 新开一个终端跑命令:Linux 优先 tmux 新窗口,其次 $TERMINAL / x-terminal-emulator。
 * 同步返回:spawn 只能报"起不来"这种错误,窗口是否真的出现由用户判断(失败时提示用 c 复制命令)。
 */
export function openInNewTerminal(command: string, cwd: string): { ok: boolean; detail: string } {
	try {
		if (process.env.TMUX) {
			const child = spawn("tmux", ["new-window", "-c", cwd, command], { detached: true, stdio: "ignore" });
			child.unref();
			return { ok: true, detail: "已在 tmux 新窗口打开" };
		}
		const terminal = (process.env.TERMINAL ?? "").trim() || "x-terminal-emulator";
		const child = spawn(terminal, ["-e", command], { detached: true, stdio: "ignore", cwd });
		child.unref();
		return { ok: true, detail: `已用 ${terminal} 打开(若无反应,按 c 复制命令手贴)` };
	} catch (error) {
		return { ok: false, detail: `新终端启动失败:${error instanceof Error ? error.message : String(error)}(可设 $TERMINAL,或按 c 复制命令)` };
	}
}
