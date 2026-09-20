/**
 * 主题:按 AI 工具着色,并尽量贴近各家 CLI 自己的品牌/主题配色。
 *
 * 取色依据(来自各工具自身的调色板,注释里标注了来源色):
 *   pi        #8abeb7(pi 内建主题的 accent,青绿)        -> 256 色 109
 *   claude    #d97757(Anthropic / Claude 橙)             -> 256 色 209
 *   opencode  #fab283(opencode TUI 主题 primary,暖橙)     -> 256 色 216
 *   codex     #10a37f(OpenAI 绿)                          -> 256 色 35
 *   zed       #5f87ff(Zed 蓝)                             -> 256 色 69
 *   gemini    #4285f4(Google 蓝)                          -> 256 色 33
 * 其他/未知工具用中性灰(250),避免喧宾夺主。
 *
 * 关闭着色:环境变量 NO_COLOR(任意值)或 AIS_COLOR=0,或输出不是 TTY。
 */

import type { Tool } from "./model.ts";

/** 工具 -> 256 色索引 */
export const TOOL_COLORS: Record<string, number> = {
	pi: 109,
	claude: 209,
	opencode: 216,
	codex: 35,
	zed: 69,
	gemini: 33,
};

/** 未知工具的中性色 */
export const NEUTRAL_COLOR = 250;

/** 被用户命名过的会话名用亮黄色突出(256 色 11 = #ffff00) */
export const NAMED_NAME_COLOR = 11;

/** 命名会话名的 SGR(不着色时为空) */
export function namedNameColor(enabled = true): string {
	if (!enabled) return "";
	return `[38;5;${NAMED_NAME_COLOR}m`;
}

/** 取工具对应的 256 色索引(纯函数) */
export function toolColorIndex(tool: string): number {
	return TOOL_COLORS[tool] ?? NEUTRAL_COLOR;
}

export interface ColorEnv {
	NO_COLOR?: string;
	AIS_COLOR?: string;
}

/** 是否应该着色:NO_COLOR 优先,其次 AIS_COLOR=0,最后看输出是否 TTY */
export function supportsColor(env: ColorEnv = process.env, isTty = true): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	if (env.AIS_COLOR === "0") return false;
	return isTty;
}

/** 工具颜色 SGR(不着色时返回空字符串) */
export function toolColor(tool: string, enabled = true): string {
	if (!enabled) return "";
	return `\u001b[38;5;${toolColorIndex(tool)}m`;
}

/** 供展示:工具名 + 颜色的简短描述(doctor 用) */
export function describeToolColors(): string {
	return Object.entries(TOOL_COLORS)
		.map(([tool, color]) => `${tool}=${color}`)
		.join(" ");
}

/** 类型收窄辅助:确保传入的是已知工具名(未知也允许,走中性色) */
export function colorForTool(tool: Tool | string, enabled = true): string {
	return toolColor(tool, enabled);
}
