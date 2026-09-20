/**
 * 按键解析(纯函数):把原始字节流切成按键名,兼容 CSI 与 SS3 两种方向键形式,
 * 并保留未完成的转义序列(PTY 分片时不能把单独的 ESC 当成退出)。
 */

export type KeyName =
	| "up"
	| "down"
	| "pageup"
	| "pagedown"
	| "home"
	| "end"
	| "enter"
	| "escape"
	| "backspace"
	| "quit"
	| { char: string };

export interface ParseResult {
	keys: KeyName[];
	/** 未完成、需等后续字节的前缀 */
	rest: string;
}

const CSI_ARROWS: Record<string, KeyName> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
};

export function parseKeys(buffer: string): ParseResult {
	const keys: KeyName[] = [];
	let index = 0;
	while (index < buffer.length) {
		const ch = buffer[index];

		if (ch === "\u001b") {
			// SS3:ESC O A/B/C/D(H/F 变体)
			if (buffer[index + 1] === "O") {
				if (index + 2 >= buffer.length) return { keys, rest: buffer.slice(index) };
				const code = buffer[index + 2];
				const name = CSI_ARROWS[code];
				if (name) {
					keys.push(name);
					index += 3;
					continue;
				}
				index += 3;
				continue;
			}
			// CSI:ESC [ ... 终止符
			if (buffer[index + 1] === "[") {
				const match = /^\u001b\[([0-9;]*)([A-Za-z~])/.exec(buffer.slice(index));
				if (!match) return { keys, rest: buffer.slice(index) }; // 分片:等后续
				const params = match[1];
				const command = match[2];
				if (command === "~") {
					const code = Number(params);
					if (code === 5) keys.push("pageup");
					else if (code === 6) keys.push("pagedown");
					else if (code === 1) keys.push("home");
					else if (code === 4) keys.push("end");
					else if (code === 3) keys.push("backspace");
				} else if (CSI_ARROWS[command]) {
					keys.push(CSI_ARROWS[command]);
				}
				index += match[0].length;
				continue;
			}
			// 单独的 ESC:可能是退出,也可能是不完整序列的开头
			if (index + 1 >= buffer.length) return { keys, rest: buffer.slice(index) };
			keys.push("escape");
			index += 1;
			continue;
		}

		if (ch === "\r" || ch === "\n") {
			keys.push("enter");
			index += 1;
			continue;
		}
		if (ch === "\u007f" || ch === "\b") {
			keys.push("backspace");
			index += 1;
			continue;
		}
		if (ch === "\u0003") {
			keys.push("quit");
			index += 1;
			continue;
		}
		if (ch === "\u0010") {
			keys.push("up");
			index += 1;
			continue;
		}
		if (ch === "\u000e") {
			keys.push("down");
			index += 1;
			continue;
		}
		keys.push({ char: ch });
		index += 1;
	}
	return { keys, rest: "" };
}
