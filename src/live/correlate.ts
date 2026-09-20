/**
 * 合并逻辑(纯函数):把会话存储记录、活体进程、终端标签、心跳拼成带标注的视图
 *
 * 匹配优先级:
 *   1) 心跳(sessionId / sessionFile 精确匹配)——最可靠
 *   2) 终端标签标题(含会话名)——可精确定位到标签,支持一键聚焦
 *   3) 进程启动时间与会话创建时间接近(±90s)兜底
 */

import type { ConsoleWindow, Heartbeat, LiveProcess, SessionRecord, SessionView, TerminalTab } from "../model.ts";

export interface CorrelateInput {
	sessions: SessionRecord[];
	processes: LiveProcess[];
	tabs: TerminalTab[];
	/** 非 Windows Terminal 的控制台窗口(按 pid 对应) */
	consoleWindows?: ConsoleWindow[];
	heartbeats: Heartbeat[];
	/** 进程启动时间与会话创建时间的容差(毫秒) */
	timeToleranceMs?: number;
}

/** pi-tab-status 写出的字形 → 状态语义 */
const GLYPH_STATUS: Record<string, { status: string; attention?: boolean }> = {
	"◐": { status: "working" },
	"◓": { status: "working" },
	"◑": { status: "working" },
	"◒": { status: "working" },
	"▸": { status: "tool" },
	_: { status: "waiting", attention: true },
	"?": { status: "stalled" },
	"×": { status: "error", attention: true },
	"·": { status: "idle" },
};

export interface ParsedTabTitle {
	glyph?: string;
	name: string;
	detail?: string;
	status?: string;
	attention?: boolean;
}

/** 解析终端标签标题:"◐ 会话名 (bash)" -> { glyph, name, detail } */
export function parseTabTitle(title: string): ParsedTabTitle {
	const trimmed = title.trim();
	if (!trimmed) return { name: "" };
	const first = trimmed[0];
	const known = GLYPH_STATUS[first];
	let rest = trimmed;
	let glyph: string | undefined;
	if (known) {
		glyph = first;
		rest = trimmed.slice(1).trim();
	}
	const match = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
	const name = (match ? match[1] : rest).trim();
	const detail = match ? match[2].trim() : undefined;
	return {
		glyph,
		name,
		detail,
		status: known?.status,
		attention: known?.attention,
	};
}

function normalized(value: string): string {
	return value.toLowerCase().replace(/\s+/g, "");
}

function tabMatchesSession(tab: TerminalTab, session: SessionRecord): boolean {
	const parsed = parseTabTitle(tab.title);
	if (!parsed.name) return false;
	if (session.name) {
		const target = normalized(session.name);
		return normalized(parsed.name) === target || normalized(parsed.name).includes(target);
	}
	// 无名称会话:用主题前若干字符做弱匹配(避免误配,要求长度足够)
	const topic = normalized(session.topic).slice(0, 12);
	if (topic.length < 6) return false;
	return normalized(parsed.name).includes(topic);
}

function statusFromDetail(detail: string | undefined): { status?: string; attention?: boolean } {
	if (!detail) return {};
	if (/confirm|permission|wait/i.test(detail)) return { status: "waiting", attention: true };
	if (/no activity/i.test(detail)) return { status: "stalled" };
	if (/^HTTP\s*\d{3}/i.test(detail)) return { status: "error", attention: true };
	return {};
}

export function correlate(input: CorrelateInput): SessionView[] {
	const tolerance = input.timeToleranceMs ?? 90_000;
	const heartbeatsById = new Map<string, Heartbeat>();
	for (const hb of input.heartbeats) {
		if (hb.sessionId) heartbeatsById.set(hb.sessionId, hb);
	}

	const claimedProcesses = new Set<number>();
	const claimedTabs = new Set<string>();
	const tabKey = (tab: TerminalTab) => `${tab.windowPid}:${tab.index}`;

	const views: SessionView[] = input.sessions.map((session) => {
		const view: SessionView = { ...session, state: "stored", attention: false };

		// 1) 心跳精确匹配(按 id,或按会话文件路径)
		const hb =
			heartbeatsById.get(session.id) ??
			input.heartbeats.find((entry) => entry.sessionFile && entry.sessionFile === session.file);
		if (hb) {
			view.live = { pid: hb.pid, heartbeat: hb };
			view.state = "running";
			view.status = hb.status ?? "running";
			view.attention = Boolean(hb.attention);
		}

		// 2) 终端标签标题匹配(即使没有心跳也能定位到窗口标签)
		if (!view.live?.tab) {
			for (const tab of input.tabs) {
				if (claimedTabs.has(tabKey(tab))) continue;
				if (!tabMatchesSession(tab, session)) continue;
				const parsed = parseTabTitle(tab.title);
				const detailInfo = statusFromDetail(parsed.detail);
				view.live = { ...(view.live ?? {}), tab };
				view.state = "running";
				view.status = view.live.heartbeat?.status ?? detailInfo.status ?? parsed.status ?? view.status;
				view.attention = view.attention || Boolean(detailInfo.attention ?? parsed.attention);
				claimedTabs.add(tabKey(tab));
				break;
			}
		}

		// 2.5) 控制台窗口(conhost / PowerShell 控制台):按会话进程 pid 精确对应
		if (!view.live?.tab) {
			const pid = view.live?.pid ?? view.live?.heartbeat?.pid;
			const consoleWindow = pid ? (input.consoleWindows ?? []).find((entry) => entry.pid === pid) : undefined;
			if (consoleWindow) {
				view.live = { ...(view.live ?? {}), console: consoleWindow };
				if (view.state !== "running") view.state = "running";
			}
		}

		// 3) 进程启动时间兜底(会话创建时间与之接近)
		if (!view.live?.pid && !view.live?.heartbeat?.pid) {
			let best: LiveProcess | null = null;
			let bestDelta = Number.POSITIVE_INFINITY;
			for (const proc of input.processes) {
				if (proc.tool !== session.tool || proc.internal) continue;
				if (claimedProcesses.has(proc.pid)) continue;
				const delta = Math.abs(proc.startedAt.getTime() - session.createdAt.getTime());
				if (delta <= tolerance && delta < bestDelta) {
					best = proc;
					bestDelta = delta;
				}
			}
			if (best) {
				view.live = { ...(view.live ?? {}), pid: best.pid };
				view.state = "running";
				view.status = view.status ?? "running";
				claimedProcesses.add(best.pid);
			}
		}

		return view;
	});

	return views.sort((a, b) => {
		const rank = (v: SessionView) => (v.state === "running" ? 0 : 1);
		if (rank(a) !== rank(b)) return rank(a) - rank(b);
		return b.updatedAt.getTime() - a.updatedAt.getTime();
	});
}
