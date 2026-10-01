#!/usr/bin/env node
/**
 * Claude Code 心跳钩子:由 Claude Code hooks 调用,从 stdin 读事件 JSON,
 * 把运行状态写到 ~/.ai-sessions/live/claude-<session_id>.json
 *
 * 事件 → 状态映射:
 *   SessionStart       -> idle
 *   UserPromptSubmit   -> working
 *   PreToolUse         -> tool
 *   PostToolUse        -> working
 *   Notification       -> waiting(attention)
 *   Stop / SubagentStop-> idle
 *   SessionEnd         -> 删除心跳
 *
 * 设计:永不抛错、永不阻塞(任何异常都静默退出 0),避免影响 Claude Code 本体。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE_DIR = join(homedir(), ".ai-sessions", "live");

/**
 * 注册表 GC(与 pi 侧同一策略):崩溃遗留的心跳会越积越多。
 * 损坏/时间戳不可解析 → 删;僵僵 pid 且超 24 小时 → 删;超 7 天 → 删。失败静默。
 */
const GC_DEAD_AGE_MS = 24 * 3600_000;
const GC_MAX_AGE_MS = 7 * 24 * 3600_000;

function pidAlive(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function sweepHeartbeatRegistry() {
	try {
		for (const name of readdirSync(LIVE_DIR)) {
			if (!name.endsWith(".json")) continue;
			const file = join(LIVE_DIR, name);
			try {
				const info = JSON.parse(readFileSync(file, "utf8"));
				const age = Date.now() - Date.parse(String(info?.updatedAt ?? ""));
				if (!Number.isFinite(age) || age > GC_MAX_AGE_MS || (age > GC_DEAD_AGE_MS && !pidAlive(info?.pid))) {
					rmSync(file, { force: true });
				}
			} catch {
				rmSync(file, { force: true });
			}
		}
	} catch {
		/* 目录不存在或没权限:不影响 Claude Code */
	}
}

const STATE_BY_EVENT = {
	SessionStart: { status: "idle", attention: false },
	UserPromptSubmit: { status: "working", attention: false },
	PreToolUse: { status: "tool", attention: false },
	PostToolUse: { status: "working", attention: false },
	Notification: { status: "waiting", attention: true },
	Stop: { status: "idle", attention: false },
	SubagentStop: { status: "working", attention: false },
	PreCompact: { status: "working", attention: false },
};

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function main() {
	const raw = readStdin();
	if (!raw.trim()) return;
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return;
	}
	const sessionId = payload.session_id ?? payload.sessionId;
	if (!sessionId) return;
	const file = join(LIVE_DIR, `claude-${sessionId}.json`);

	if (payload.hook_event_name === "SessionEnd") {
		try {
			rmSync(file, { force: true });
		} catch {
			/* 忽略 */
		}
		return;
	}

	const state = STATE_BY_EVENT[payload.hook_event_name] ?? { status: "running", attention: false };
	if (payload.hook_event_name === "SessionStart") sweepHeartbeatRegistry();
	try {
		mkdirSync(LIVE_DIR, { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				{
					tool: "claude",
					sessionId,
					sessionFile: payload.transcript_path,
					cwd: payload.cwd,
					status: state.status,
					attention: state.attention,
					event: payload.hook_event_name,
					updatedAt: new Date().toISOString(),
				},
				null,
				1,
			),
		);
	} catch {
		/* 忽略 */
	}
}

main();
