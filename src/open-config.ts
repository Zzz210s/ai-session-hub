/**
 * 打开会话的配置:`~/.ai-session-hub/config.json` 的 `open` 段 + 环境变量覆盖。
 *
 * 为什么单独一层:窗口行为是本机口味(有人要新窗口、有人要新标签、有人要就地接管),
 * 写死任何一种是错的。配置文件给常驻口径,环境变量给临时覆盖(便于脚本里试)。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenMode = "window" | "tab" | "attach";
export type GeometryMode = "inherit" | "none";

export interface OpenConfig {
	/** window=新窗口(默认) / tab=当前窗口新标签 / attach=就地接管当前终端 */
	mode: OpenMode;
	/** inherit=跟当前窗口同一个 profile;也可写 profile 名 */
	profile: string;
	/** inherit=复制当前窗口的大小与位置;none=交给 Windows Terminal 自己决定 */
	geometry: GeometryMode;
	/** 覆盖项:`"120,30"`(列,行) */
	size: string | null;
	/** 覆盖项:`"100,80"`(屏幕坐标) */
	pos: string | null;
	/** true=最大化 / false=不最大化 / null=跟当前窗口 */
	maximized: boolean | null;
}

export const DEFAULT_OPEN: OpenConfig = {
	mode: "window",
	profile: "inherit",
	geometry: "inherit",
	size: null,
	pos: null,
	maximized: null,
};

export function configPath(home: string = homedir()): string {
	return join(home, ".ai-session-hub", "config.json");
}

function asMode(value: unknown): OpenMode | undefined {
	return value === "window" || value === "tab" || value === "attach" ? value : undefined;
}

function asGeometry(value: unknown): GeometryMode | undefined {
	return value === "inherit" || value === "none" ? value : undefined;
}

function asBool(value: unknown): boolean | null | undefined {
	if (value === true || value === false) return value;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	if (value === "inherit" || value === "" || value === null || value === undefined) return undefined;
	return undefined;
}

function asText(value: unknown): string | null | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** 读配置文件的 `open` 段;文件缺失/损坏一律当默认值(不该因为配置坏了就打不开会话) */
export function readOpenConfig(path: string = configPath(), readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): OpenConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFile(path));
	} catch {
		return { ...DEFAULT_OPEN };
	}
	const open = (raw as { open?: Record<string, unknown> } | null)?.open;
	if (!open || typeof open !== "object") return { ...DEFAULT_OPEN };
	const size = asText(open.size);
	const pos = asText(open.pos);
	const maximized = asBool(open.maximized);
	return {
		mode: asMode(open.mode) ?? DEFAULT_OPEN.mode,
		profile: asText(open.profile) ?? DEFAULT_OPEN.profile,
		geometry: asGeometry(open.geometry) ?? DEFAULT_OPEN.geometry,
		size: size ?? DEFAULT_OPEN.size,
		pos: pos ?? DEFAULT_OPEN.pos,
		maximized: maximized === undefined ? DEFAULT_OPEN.maximized : maximized,
	};
}

/** 环境变量覆盖(临时试参数用):AIS_OPEN_MODE / _PROFILE / _GEOMETRY / _SIZE / _POS / _MAXIMIZED */
export function applyEnvOverrides(config: OpenConfig, env: NodeJS.ProcessEnv = process.env): OpenConfig {
	const next: OpenConfig = { ...config };
	const mode = asMode(env.AIS_OPEN_MODE?.trim());
	if (mode) next.mode = mode;
	const geometry = asGeometry(env.AIS_OPEN_GEOMETRY?.trim());
	if (geometry) next.geometry = geometry;
	const profile = asText(env.AIS_OPEN_PROFILE);
	if (profile !== undefined) next.profile = profile ?? "inherit";
	const size = asText(env.AIS_OPEN_SIZE);
	if (size !== undefined) next.size = size;
	const pos = asText(env.AIS_OPEN_POS);
	if (pos !== undefined) next.pos = pos;
	const maximized = asBool(env.AIS_OPEN_MAXIMIZED?.trim());
	if (maximized !== undefined) next.maximized = maximized;
	return next;
}

/** 常驻口径 + 环境变量,一步拿到最终配置 */
export function loadOpenConfig(env: NodeJS.ProcessEnv = process.env, path: string = configPath()): OpenConfig {
	return applyEnvOverrides(readOpenConfig(path), env);
}
