/**
 * 启动前自更新的 TTL 跳过(2026-10-05,用户要求"ais 启动太慢")。
 *
 * 实测:一次完整启动前自更新 14.2s —— pi 本体 3.9s + pi 扩展 6.2s + Claude 6.0s +
 * Claude 插件 1.9s(并行后墙钟 ≈ 10.1s),再加 DSH 全局 CLI 探测 ~3s 与 GUI 应用版本
 * 读取 ~1.1s。这几条命令即使"已是最新"也要各自去 npm 走一趟元数据。
 *
 * 用户要的是"会话启动前把更新跑完",不是"每次启动都重新问一遍 npm",所以按**上次完整
 * 成功的时间**做 TTL 跳过:TTL 内直接跳过(打印一行说明),过期则照旧完整跑一遍。
 *
 * 与旧决策的关系:2026-10-01 用户说过"没必要检测,直接跑一遍 update 相关命令" —— 那指的
 * 是**不要做版本比对**(跨安装方式易碎)。TTL 只记时间戳、不比对版本,不违背该决策;
 * 想恢复"每次都查"的旧行为,把 AIS_UPDATE_TTL 设成 0 即可。
 *
 * 状态文件 `~/.ai-session-hub/preflight-state.json` 只在**全部步骤成功**后写入;任何一步
 * 失败都不写,于是下次启动会立刻重试(不会被 TTL 挡住)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 默认 6 小时:一个工作日大约查 1-2 次,同时把"最多落后 6 小时"作为代价摊平 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** 状态文件格式版本(改结构时递增,老文件按未命中处理 —— 与扫描缓存同一套纪律) */
export const STATE_FORMAT_VERSION = 1;

export interface PreflightState {
	version: number;
	/** 上次全部步骤成功的时刻(epoch ms) */
	lastSuccessAt?: number;
}

/** 解析 AIS_UPDATE_TTL:纯毫秒数字,或带 s/m/h/d 后缀;0 表示每次都查;非法值回落默认 */
export function parseTtl(raw: string | undefined, fallback: number = DEFAULT_TTL_MS): number {
	if (raw === undefined) return fallback;
	const text = raw.trim().toLowerCase();
	if (text.length === 0) return fallback;
	const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(text);
	if (!match) return fallback;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return fallback;
	const unit = match[2];
	const scale = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 1;
	return value * scale;
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.AIS_HOME?.trim() || join(homedir(), ".ai-session-hub");
	return join(home, "preflight-state.json");
}

/** 读状态:文件缺失/损坏/版本不符一律当作"没有记录"(返回空状态),不抛错 */
export function readPreflightState(file: string): PreflightState {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PreflightState>;
		if (parsed?.version !== STATE_FORMAT_VERSION) return { version: STATE_FORMAT_VERSION };
		const at = parsed.lastSuccessAt;
		if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return { version: STATE_FORMAT_VERSION };
		return { version: STATE_FORMAT_VERSION, lastSuccessAt: at };
	} catch {
		return { version: STATE_FORMAT_VERSION };
	}
}

/** 写状态:只在全部成功时调用;写不进去也不影响启动(下次就当没记录,重跑一遍) */
export function writePreflightState(file: string, at: number = Date.now()): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: STATE_FORMAT_VERSION, lastSuccessAt: at }, null, 2) + "\n", "utf8");
	} catch {
		/* 尽力而为 */
	}
}

/** 中文时长:3.2 小时 / 12 分钟 / 45 秒 */
export function formatAge(ms: number): string {
	if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
	if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
	return `${Math.max(1, Math.round(ms / 1_000))} 秒`;
}

/**
 * 该不该跳过:返回 `undefined` 表示要跑,返回字符串表示跳过的原因(直接进摘要行)。
 * ttl <= 0 时永不跳过。
 */
export function skipReason(state: PreflightState, now: number, ttlMs: number): string | undefined {
	if (ttlMs <= 0) return undefined;
	const at = state.lastSuccessAt;
	if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
	const age = now - at;
	if (age < 0 || age >= ttlMs) return undefined; // 时钟倒退也当作过期,重跑更安全
	return `${formatAge(age)}前检查过,跳过(${formatAge(ttlMs)}内不重复;AIS_UPDATE_TTL=0 可关闭跳过)`;
}
