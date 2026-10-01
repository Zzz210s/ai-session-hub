/**
 * pi 心跳扩展:把"我在跑、我是哪个会话、当前什么状态"写到 ~/.ai-sessions/live/pi-<pid>.json
 * 由 ai-session-hub 读取,用于把"历史会话"精确标成"运行中",并给出等待/出错等状态。
 *
 * 安装:bash setup.sh(会复制到 ~/.pi/agent/extensions/),或手动复制本文件。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LIVE_DIR = join(homedir(), ".ai-sessions", "live");
const REFRESH_MS = 30_000;

/**
 * 心跳注册表 GC:崩溃/被杀掉的会话会把自己的心跳文件留在目录里(正常退出会删掉),
 * 日积月累后目录可能上千个文件,每次读取都要 stat+read 全部文件。启动时扫一遍:
 *   - 记录损坏或时间戳无法解析 → 删(读取方本来就会忽略)
 *   - 僵僵 pid 且超过 24 小时 → 删
 *   - 超过 7 天 → 删(不论 pid,避免 pid 复用后误判为活着)
 * 目录清理后读者烦恼就少一半(只读新鲜文件)。失败静默。
 */
const GC_DEAD_AGE_MS = 24 * 3600_000;
const GC_MAX_AGE_MS = 7 * 24 * 3600_000;

function pidAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function sweepHeartbeatRegistry(): void {
	try {
		const mine = `pi-${process.pid}.json`;
		for (const name of readdirSync(LIVE_DIR)) {
			if (!name.endsWith(".json") || name === mine) continue;
			const file = join(LIVE_DIR, name);
			try {
				const info = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; updatedAt?: unknown };
				const age = Date.now() - Date.parse(String(info?.updatedAt ?? ""));
				if (!Number.isFinite(age) || age > GC_MAX_AGE_MS || (age > GC_DEAD_AGE_MS && !pidAlive(info?.pid))) {
					rmSync(file, { force: true });
				}
			} catch {
				rmSync(file, { force: true });
			}
		}
	} catch {
		/* 目录不存在或没权限:不影响 pi */
	}
}

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
		sweepHeartbeatRegistry();
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
