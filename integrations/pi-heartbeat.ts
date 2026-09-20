/**
 * pi 心跳扩展:把"我在跑、我是哪个会话、当前什么状态"写到 ~/.ai-sessions/live/pi-<pid>.json
 * 由 ai-session-hub 读取,用于把"历史会话"精确标成"运行中",并给出等待/出错等状态。
 *
 * 安装:bash setup.sh(会复制到 ~/.pi/agent/extensions/),或手动复制本文件。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LIVE_DIR = join(homedir(), ".ai-sessions", "live");
const REFRESH_MS = 30_000;

export default function (pi: ExtensionAPI) {
	let sessionId = "";
	let sessionFile: string | undefined;
	let cwd = process.cwd();
	let name: string | undefined;
	let status = "idle";
	let attention = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const heartbeatFile = (): string => join(LIVE_DIR, `pi-${process.pid}.json`);

	const write = (): void => {
		try {
			mkdirSync(LIVE_DIR, { recursive: true });
			writeFileSync(
				heartbeatFile(),
				JSON.stringify(
					{
						tool: "pi",
						pid: process.pid,
						sessionId,
						sessionFile,
						cwd,
						name,
						status,
						attention,
						updatedAt: new Date().toISOString(),
					},
					null,
					1,
				),
			);
		} catch {
			/* 心跳失败不影响 pi */
		}
	};

	const remove = (): void => {
		try {
			rmSync(heartbeatFile(), { force: true });
		} catch {
			/* 忽略 */
		}
	};

	const setState = (next: string, isAttention = false): void => {
		status = next;
		attention = isAttention;
		write();
	};

	const captureSession = (ctx: ExtensionContext): void => {
		try {
			sessionId = ctx.sessionManager.getSessionId();
			sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			cwd = ctx.sessionManager.getCwd();
			const current = ctx.sessionManager.getSessionName?.();
			if (current) name = current;
		} catch {
			/* 老版本 API 差异兜底 */
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		captureSession(ctx);
		setState("idle");
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			captureSession(ctx);
			write();
		}, REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_info_changed", async (event) => {
		if (event?.name) name = event.name;
		write();
	});

	pi.on("agent_start", async () => setState("working"));
	pi.on("message_update", async () => {
		if (status !== "waiting") setState("working");
	});
	pi.on("tool_execution_start", async () => setState("tool"));
	pi.on("tool_execution_end", async () => setState("working"));
	pi.on("ui_prompt_start", async () => setState("waiting", true));
	pi.on("ui_prompt_end", async () => setState("working"));
	pi.on("after_provider_response", async (event) => {
		if (typeof event?.status === "number" && event.status >= 400) setState("error", true);
	});
	pi.on("agent_settled", async () => setState("idle"));
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		remove();
	});
}
