/**
 * 终端文本工具(纯函数):显示宽度、补齐、截断、ANSI 处理、宽度不确定字符净化
 */

/** 终端显示宽度(CJK 与 emoji 记 2 列) */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1f9ff);
		width += wide ? 2 : 1;
	}
	return width;
}

/** 按显示宽度截断并补齐(仅用于纯文本,不要传含 ANSI 的字符串) */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = displayWidth(ch);
		if (used + w > width) break;
		out += ch;
		used += w;
	}
	return out + " ".repeat(Math.max(0, width - used));
}

/** 剔除 ANSI 转义序列(用于统计可见宽度) */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * 行宽护栏:按显示宽度截断(保留 ANSI 转义),确保整行不超过终端宽度。
 * 必要性:一旦某行超宽,终端会折行并重定位光标,整个界面会错乱。
 */
export function clampLine(line: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let used = 0;
	let index = 0;
	while (index < line.length) {
		const ch = line[index];
		if (ch === "\u001b") {
			const match = /^\u001b\[[0-9;?]*[a-zA-Z]/.exec(line.slice(index));
			if (match) {
				out += match[0];
				index += match[0].length;
				continue;
			}
		}
		const w = displayWidth(ch);
		if (used + w > width) break;
		out += ch;
		used += w;
		index += 1;
	}
	return `${out}\u001b[0m`;
}

/** 按可见宽度补空格(保留 ANSI);不能用 fit() 处理含 ANSI 的字符串 */
export function padVisible(line: string, width: number): string {
	const visible = displayWidth(stripAnsi(line));
	if (visible >= width) return clampLine(line, width);
	return `${line}${" ".repeat(width - visible)}`;
}

/**
 * 显示净化:会话标题/路径等数据里可能带宽度不确定字符(● ▸ · × … 等),
 * 部分终端按双宽渲染会让整列错位;统一换成 ASCII 等价物(emoji 保留,按 2 列计)。
 */
export function sanitizeForDisplay(text: string): string {
	return text
		.replace(/[●○◐◑◒◓]/g, "o")
		.replace(/[▸▶►]/g, ">")
		.replace(/‖/g, "|")
		.replace(/[·•]/g, "-")
		.replace(/[×✕✗]/g, "x")
		.replace(/…/g, "...")
		.replace(/[—–]/g, "-")
		.replace(/[✓✔]/g, "v");
}
