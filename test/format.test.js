import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, formatRow, shortCwd, summarize, title } from "../src/format.ts";

const NOW = new Date("2026-09-21T12:00:00Z");

function view(overrides = {}) {
	return {
		tool: "pi",
		id: "abcdef123456",
		file: "C:/sessions/a.jsonl",
		cwd: "C:\\Users\\me\\config-ai",
		name: "重构登录",
		topic: "重构登录",
		firstMessage: "",
		createdAt: new Date("2026-09-21T09:00:00Z"),
		updatedAt: new Date("2026-09-21T11:57:00Z"),
		state: "stored",
		attention: false,
		...overrides,
	};
}

test("formatAge:各档位", () => {
	assert.equal(formatAge(new Date(NOW.getTime() - 30_000), NOW), "刚刚");
	assert.equal(formatAge(new Date(NOW.getTime() - 12 * 60_000), NOW), "12分钟前");
	assert.equal(formatAge(new Date(NOW.getTime() - 3 * 3_600_000), NOW), "3小时前");
	assert.equal(formatAge(new Date(NOW.getTime() - 2 * 86_400_000), NOW), "2天前");
	assert.equal(formatAge(new Date("2026-01-05T00:00:00Z"), NOW), "2026-01-05");
});

test("shortCwd:取末段", () => {
	assert.equal(shortCwd("C:\\Users\\me\\config-ai"), "config-ai");
	assert.equal(shortCwd("/home/me/work/"), "work");
	assert.equal(shortCwd(""), "-");
});

test("title:名称 > 主题 > id 前缀", () => {
	assert.equal(title(view()), "重构登录");
	assert.equal(title(view({ name: undefined, topic: "随便聊聊" })), "随便聊聊");
	assert.equal(title(view({ name: undefined, topic: "" })), "abcdef12");
});

test("formatRow:包含工具、名称、目录、年龄与活性", () => {
	const row = formatRow(view({ state: "running", status: "working", live: { tab: { windowPid: 1, index: 4, title: "◐ 重构登录", selected: false, hwnd: "1", windowTitle: "" } } }), NOW);
	assert.match(row, /^\[\*\*\]/);
	assert.match(row, /pi/);
	assert.match(row, /重构登录/);
	assert.match(row, /config-ai/);
	assert.match(row, /3分钟前/);
	assert.match(row, /tab 4/);

	const stored = formatRow(view(), NOW);
	assert.match(stored, /历史/);
});

test("summarize:计数与需关注统计", () => {
	const summary = summarize([
		view({ state: "running" }),
		view({ state: "running", attention: true, tool: "claude" }),
		view({ state: "stored", tool: "opencode" }),
	]);
	assert.equal(summary.total, 3);
	assert.equal(summary.running, 2);
	assert.equal(summary.attention, 1);
	assert.deepEqual(summary.byTool, { pi: 1, claude: 1, opencode: 1 });
});
