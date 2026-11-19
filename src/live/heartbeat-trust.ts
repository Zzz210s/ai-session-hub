/**
 * 心跳可信度判定(2026-11-19,修「无法删除会话」)。
 *
 * 问题现场:板面把 `01a1f3c7` 标成 running,而心跳里的 pid 42924 现在是一个**无关的 node 进程**
 * (PID 被复用);另有两个心跳的 pid 早已退出、记录停在前一天。它们全被 `planDelete` 拦下
 * (「会话正在运行:请先聚焦该窗口(f)并退出会话,再删除」),于是**删不掉**。
 *
 * 判据(pi / claude 的会话都在**每分钟**刷新一次心跳,所以"过期"本身就说明它不在跑了):
 *   1. 心跳时间无法解析 → 信它(信息不足时保守:误删正在写入的会话比多拦一次严重得多)
 *   2. 心跳超过 STALE_MS 没更新 → 不信(记录残留)
 *   3. 探测结果里没有这个 pid → 信它(探测可能不全:超时、权限、只枚举了部分进程名)
 *   4. 这个 pid 属于**别的工具** → 不信(PID 复用)
 *   5. 命令行里写明了另一个会话文件 → 不信(同一个 pid 换成了别的会话)
 *   6. 其余 → 信
 */

import { basename } from "node:path";
import type { Heartbeat, LiveProcess } from "../model.ts";

/** 心跳多久没更新就算残留:写入方每分钟刷一次,留 10 分钟余量 */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

/** 把心跳里的时间戳变成毫秒;无法解析返回 undefined */
export function heartbeatAgeMs(updatedAt: unknown, now = Date.now()): number | undefined {
	if (typeof updatedAt !== "string" || !updatedAt.trim()) return undefined;
	const at = Date.parse(updatedAt);
	if (!Number.isFinite(at)) return undefined;
	return now - at;
}

/**
 * 从进程命令行里取会话文件:`--session <path>` / `--session=<path>`(路径可能带引号)。
 * 取不到返回 undefined —— 调用方据此判断"命令行没提供会话信息"。
 */
export function sessionFileFromArgs(args: string): string | undefined {
	if (!args) return undefined;
	const match = /--session[=\s]+("([^"]+)"|'([^']+)'|(\S+))/.exec(args);
	if (!match) return undefined;
	return match[2] ?? match[3] ?? match[4];
}

export interface TrustVerdict {
	trusted: boolean;
	/** 不可信的原因(调试/提示用) */
	reason?: string;
}

/** 心跳是否可信(纯函数,便于单测) */
export function heartbeatTrusted(hb: Heartbeat, processes: LiveProcess[], now = Date.now()): TrustVerdict {
	const age = heartbeatAgeMs(hb.updatedAt, now);
	if (age !== undefined && age > HEARTBEAT_STALE_MS) return { trusted: false, reason: "心跳已过期(会话不在运行)" };
	if (hb.pid === undefined) return { trusted: true };
	const process = processes.find((entry) => entry.pid === hb.pid);
	if (!process) return { trusted: true };
	if (process.tool !== hb.tool) return { trusted: false, reason: `pid ${hb.pid} 已被别的程序占用` };
	const fromArgs = sessionFileFromArgs(process.args);
	if (fromArgs && hb.sessionFile && basename(fromArgs) !== basename(hb.sessionFile)) {
		return { trusted: false, reason: `pid ${hb.pid} 指向另一个会话` };
	}
	return { trusted: true };
}
