import assert from "node:assert/strict";
import { test } from "node:test";
import { correlate, parseTabTitle } from "../src/live/correlate.ts";

const session = (over = {}) => ({
	tool: "pi",
	id: "sess-1",
	file: "C:/sessions/1.jsonl",
	cwd: "C:\\work\\proj",
	name: "重构登录",
	topic: "重构登录",
	firstMessage: "",
	createdAt: new Date("2026-09-21T10:00:00Z"),
	updatedAt: new Date("2026-09-21T11:00:00Z"),
	...over,
});

const tab = (over = {}) => ({
	hwnd: "1",
	windowPid: 100,
	windowTitle: "重构登录",
	index: 0,
	title: "◐ 重构登录",
	selected: false,
	...over,
});

test("parseTabTitle:解析字形、名称与细节", () => {
	assert.deepEqual(parseTabTitle("◐ 重构登录"), { glyph: "◐", name: "重构登录", detail: undefined, status: "working", attention: undefined });
	const waiting = parseTabTitle("_ 三系统 (confirm)");
	assert.equal(waiting.name, "三系统");
	assert.equal(waiting.detail, "confirm");
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.attention, true);
	const plain = parseTabTitle("给我个名字");
	assert.equal(plain.glyph, undefined);
	assert.equal(plain.name, "给我个名字");
});

test("correlate:心跳精确匹配优先,并带上状态与需关注", () => {
	const views = correlate({
		sessions: [session()],
		processes: [],
		tabs: [],
		heartbeats: [{ tool: "pi", pid: 4242, sessionId: "sess-1", status: "waiting", attention: true, updatedAt: new Date().toISOString() }],
	});
	assert.equal(views[0].state, "running");
	assert.equal(views[0].status, "waiting");
	assert.equal(views[0].attention, true);
	assert.equal(views[0].live?.pid, 4242);
});

test("correlate:无心跳时用标签标题匹配并记录标签位置", () => {
	const views = correlate({
		sessions: [session()],
		processes: [],
		tabs: [tab({ index: 3, title: "▸ 重构登录 (bash)" })],
		heartbeats: [],
	});
	assert.equal(views[0].state, "running");
	assert.equal(views[0].status, "tool");
	assert.equal(views[0].live?.tab?.index, 3);
});

test("correlate:标签细节里的 confirm 会标记为等待/需关注", () => {
	const views = correlate({
		sessions: [session({ name: "三系统" })],
		processes: [],
		tabs: [tab({ title: "? 三系统 (confirm)" })],
		heartbeats: [],
	});
	assert.equal(views[0].attention, true);
	assert.equal(views[0].status, "waiting");
});

test("correlate:进程启动时间兜底(容差内)", () => {
	const views = correlate({
		sessions: [session({ createdAt: new Date("2026-09-21T10:00:00Z") })],
		processes: [{ pid: 777, tool: "pi", startedAt: new Date("2026-09-21T10:00:30Z"), args: "" }],
		tabs: [],
		heartbeats: [],
	});
	assert.equal(views[0].state, "running");
	assert.equal(views[0].live?.pid, 777);
});

test("correlate:容差外不匹配,保持历史态", () => {
	const views = correlate({
		sessions: [session({ createdAt: new Date("2026-09-21T10:00:00Z") })],
		processes: [{ pid: 777, tool: "pi", startedAt: new Date("2026-09-21T10:30:00Z"), args: "" }],
		tabs: [],
		heartbeats: [],
	});
	assert.equal(views[0].state, "stored");
});

test("correlate:运行中的会话排在前面", () => {
	const views = correlate({
		sessions: [session({ id: "old", updatedAt: new Date("2026-09-21T11:59:00Z") }), session({ id: "live", name: "三系统" })],
		processes: [],
		tabs: [tab({ title: "· 三系统" })],
		heartbeats: [],
	});
	assert.equal(views[0].id, "live");
});

test("correlate:非 Windows Terminal 时按 pid 匹配控制台窗口", () => {
	const views = correlate({
		sessions: [session({ id: "c1", name: "ps-session" })],
		processes: [],
		tabs: [],
		consoleWindows: [{ hwnd: "4242", pid: 999, title: "Windows PowerShell" }],
		heartbeats: [{ tool: "pi", pid: 999, sessionId: "c1", status: "idle", updatedAt: new Date().toISOString() }],
	});
	assert.equal(views[0].live?.console?.hwnd, "4242");
	assert.equal(views[0].state, "running");
});

test("correlate:控制台窗口 pid 与会话进程不一致时不误匹配", () => {
	const views = correlate({
		sessions: [session({ id: "c2" })],
		processes: [],
		tabs: [],
		consoleWindows: [{ hwnd: "4242", pid: 111, title: "Windows PowerShell" }],
		heartbeats: [{ tool: "pi", pid: 999, sessionId: "c2", updatedAt: new Date().toISOString() }],
	});
	assert.equal(views[0].live?.console, undefined);
});
