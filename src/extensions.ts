/**
 * 拓展接口 + 加载器 —— ai-session-hub 的核心是"会话总览",同页分屏等能力由拓展提供。
 *
 * 拓展是一个普通模块(通常是 npm 包/仓库),导出 `createHubExtension()` 返回对象:
 *   {
 *     name: "tui-panes",
 *     hints: ["Enter 分屏打开", "Tab 切换面板", "x 关闭面板"],   // 可选:底部提示
 *     bodyView(ctx): string[] | undefined,                      // 可选:接管主体区渲染
 *     handleKey(key, ctx): boolean,                             // 可选:按键(返回 true 表示已消费)
 *     handleRawInput(text, ctx): boolean,                       // 可选:原始输入(面板聚焦时用)
 *     onResize(ctx): void,                                      // 可选:尺寸变化
 *     dispose(): void,                                          // 可选:退出清理
 *   }
 *
 * 加载顺序:环境变量 AIS_EXTENSIONS(逗号分隔) > ~/.ai-session-hub/extensions.json >
 * 默认 ["tui-panes"](装了就用,没装就跳过——核心功能不受影响)。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 传给拓展的会话信息(核心负责把"如何恢复该会话"也算好,拓展无需了解内部细节) */
export interface ExtensionSession {
	id: string;
	/** 展示名(会话名或主题) */
	title: string;
	tool: string;
	cwd: string;
	/** 恢复该会话的命令(拓展可直接在 PTY 里执行) */
	command: string;
	/** running | stored */
	state: string;
}

export interface ExtensionContext {
	/** 当前选中的会话(含恢复命令) */
	selected(): ExtensionSession | undefined;
	/** 可用尺寸(主体区左右宽度与高度) */
	metrics(): { leftWidth: number; rightWidth: number; bodyHeight: number };
	/** 给用户提示 */
	notify(message: string): void;
	/** 立即重绘 / 请求节流重绘 */
	redraw(): void;
	schedule(): void;
}

export interface HubExtension {
	name: string;
	/** 底部提示片段(展示了拓展自己的按键) */
	hints?: string[];
	/** 在拓展的视图中打开当前选中项(核心的 Enter 智能动作会调用) */
	openSelected?(ctx: ExtensionContext): void | Promise<void>;
	/** 接管主体区渲染;返回 undefined 表示不接管(仍显示核心的详情视图) */
	bodyView?(ctx: ExtensionContext): string[] | undefined;
	/** 按键处理;返回 true 表示已消费 */
	handleKey?(key: unknown, ctx: ExtensionContext): boolean | Promise<boolean>;
	/** 原始输入处理(在按键解析之前;分屏聚焦时按键要直达会话) */
	handleRawInput?(text: string, ctx: ExtensionContext): boolean;
	onResize?(ctx: ExtensionContext): void;
	dispose?(): void;
}

export interface LoadedExtension {
	name: string;
	extension: HubExtension;
	/** 加载失败时的原因(此时 extension 为占位空实现) */
	error?: string;
}

export const DEFAULT_EXTENSIONS = ["tui-panes"];

export function extensionsConfigPath(): string {
	return join(homedir(), ".ai-session-hub", "extensions.json");
}

/**
 * 解析要加载的拓展清单(纯函数,便于单测)。
 * 语义:
 *   - AIS_EXTENSIONS 逗号分隔;其中出现 none 表示"不要任何拓展"
 *   - 配置文件里 extensions 是数组时以它为准(空数组 = 不要任何拓展)
 *   - 两者都没有 -> 默认清单
 * 说明:显式的空清单必须能表达"核心单独运行",所以空数组不会被当成未配置。
 */
export function resolveExtensionList(options: { env?: string; config?: string; defaults?: string[] } = {}): string[] {
	const defaults = options.defaults ?? DEFAULT_EXTENSIONS;
	const envRaw = (options.env ?? "").trim();
	if (envRaw) {
		const items = envRaw.split(",").map((item) => item.trim()).filter(Boolean);
		if (items.includes("none")) return [];
		if (items.length) return items;
	}
	if (options.config) {
		try {
			const parsed = JSON.parse(options.config) as { extensions?: unknown };
			if (Array.isArray(parsed.extensions)) {
				return parsed.extensions.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
			}
		} catch {
			/* 配置损坏时回退默认 */
		}
	}
	return defaults;
}

/** 当前生效的拓展清单(供 doctor 展示) */
export function configuredExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
	return resolveExtensionList({ env: env.AIS_EXTENSIONS, config: readConfig() });
}

function readConfig(): string | undefined {
	const path = extensionsConfigPath();
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** 校验模块导出是否符合拓展约定(纯函数) */
export function validateExtension(value: unknown): HubExtension | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as HubExtension;
	if (typeof candidate.name !== "string" || !candidate.name.trim()) return null;
	return candidate;
}

/**
 * 加载拓展:每个条目要么导出 `createHubExtension()`,要么直接默认导出一个拓展对象。
 * 单个拓展加载失败只记录原因,不影响核心运行。
 */
export async function loadExtensions(specifiers?: string[]): Promise<LoadedExtension[]> {
	const list = specifiers ?? resolveExtensionList({ env: process.env.AIS_EXTENSIONS, config: readConfig() });
	const loaded: LoadedExtension[] = [];
	for (const specifier of list) {
		try {
			const module = (await import(specifier)) as Record<string, unknown>;
			const factory = module.createHubExtension ?? (module.default as Record<string, unknown> | undefined)?.createHubExtension;
			const raw = typeof factory === "function" ? await (factory as () => unknown)() : (module.default ?? module.createHubExtension);
			const extension = validateExtension(raw);
			if (!extension) throw new Error("模块未导出有效的拓展(需要 name 字段)");
			loaded.push({ name: extension.name, extension });
		} catch (error) {
			loaded.push({
				name: specifier,
				extension: { name: specifier },
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return loaded;
}
