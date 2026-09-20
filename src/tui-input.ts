/**
 * 原始输入处理:把字节流切成按键并交给分发器。
 * 单独成模块的原因:分片安全(未完成的转义序列要缓冲)与"拓展优先"的顺序
 * 是两处容易写错的细节,集中在一处便于测试与复用。
 */

import { parseKeys } from "./keys.ts";
import { dispatchKey, type KeyContext } from "./tui-keys.ts";

const ESCAPE_WAIT_MS = 40;

export interface InputPumpOptions {
	ctx: KeyContext;
	/** 拓展是否已消费该原始输入(面板聚焦时按键直达会话) */
	extensionHandled?: (text: string) => boolean;
	/** 输入状态变化时(仅用于测试观察) */
	onUnfinishedEscape?: (pending: string) => void;
}

export interface InputPump {
	/** 喂入一段字节 */
	feed(chunk: Buffer): void;
	/** 清理定时器 */
	dispose(): void;
}

export function createInputPump(options: InputPumpOptions): InputPump {
	let buffer = "";
	let timer: ReturnType<typeof setTimeout> | null = null;

	const handle = (text: string): void => {
		buffer += text;
		const { keys, rest } = parseKeys(buffer);
		buffer = rest;
		for (const key of keys) void dispatchKey(key, options.ctx);
		if (buffer && !timer) {
			options.onUnfinishedEscape?.(buffer);
			timer = setTimeout(() => {
				timer = null;
				const pending = buffer;
				buffer = "";
				for (const key of parseKeys(pending).keys) void dispatchKey(key, options.ctx);
			}, ESCAPE_WAIT_MS);
		}
	};

	return {
		feed(chunk) {
			const text = chunk.toString("utf8");
			// 拓展优先:面板聚焦时按键直达会话
			if (options.extensionHandled?.(text)) return;
			handle(text);
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
