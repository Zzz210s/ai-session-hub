import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, fit, renderScreen, stripAnsi, viewport } from "../src/tui-view.ts";

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

function state(overrides = {}) {
	const rows = [view({ id: "a", name: "运行中的", state: "running", status: "working", live: { tab: { windowPid: 1, index: 2, title: "◐ 运行中的", selected: true, hwnd: "1", windowTitle: "" } } }), view({ id: "b", name: "历史的" })];
	return {
		rows,
		totals: { all: 2, running: 1, attention: 0, stored: 1 },
		filter: "all",
		query: "",
		searchMode: false,
		cursor: 0,
		width: 100,
		height: 20,
		refreshedAt: NOW,
		now: NOW,
		...overrides,
	};
}

test("displayWidth:CJK 记 2 列", () => {
	assert.equal(displayWidth("abc"), 3);
	assert.equal(displayWidth("中文"), 4);
	assert.equal(displayWidth("a中b"), 4);
});

test("fit:按显示宽度截断并补齐", () => {
	assert.equal(fit("abcdef", 4), "abcd");
	assert.equal(fit("中文", 3), "中 ");
	assert.equal(fit("ab", 4), "ab  ");
	assert.equal(displayWidth(fit("重构登录模块", 7)), 7);
});

test("viewport:cursor 越界时收拢且可见", () => {
	const rows = Array.from({ length: 50 }, (_, index) => view({ id: `s${index}` }));
	const wide = viewport(state({ rows, cursor: 40, height: 14 }));
	assert.equal(wide.bodyHeight, 11);
	assert.ok(wide.start <= 40 && 40 < wide.end);
	const tail = viewport(state({ rows, cursor: 49, height: 14 }));
	assert.equal(tail.end, 50);
	const head = viewport(state({ rows, cursor: 0, height: 14 }));
	assert.equal(head.start, 0);
});

test("renderScreen:包含标题栏、统计、筛选、会话行与提示", () => {
	const lines = renderScreen(state());
	const text = lines.map(stripAnsi);
	assert.match(text[0], /AI 会话总览/);
	assert.match(text[0], /共 2/);
	assert.match(text[1], /1 运行中 1/);
	assert.match(text.join("\n"), /运行中的/);
	assert.match(text.join("\n"), /历史的/);
	assert.match(text[text.length - 1], /a 接管终端/);
	assert.equal(lines.length, 20);
});

test("renderScreen:选中行使用反显,详情显示字段", () => {
	const lines = renderScreen(state());
	const body = lines.slice(2, -1).join("\n");
	assert.ok(body.includes("\u001b[7m"), "选中行应有反显");
	const text = lines.map(stripAnsi).join("\n");
	assert.match(text, /工作目录/);
	assert.match(text, /终端标签/);
	assert.match(text, /会话文件/);
});

test("renderScreen:空列表给出引导文案", () => {
	const lines = renderScreen(state({ rows: [], cursor: 0 }));
	assert.match(lines.map(stripAnsi).join("\n"), /没有匹配的会话/);
});

test("renderScreen:底部统一为「键位 | 消息」,消息在后", () => {
	const withMessage = { ...state(), message: "已删除「演示会话」:已放入系统回收站" };
	const text = stripAnsi(renderScreen(withMessage).join("\n"));
	const footer = text.split("\n").filter((line) => line.includes("接管终端")).pop() ?? "";
	assert.match(footer, /接管终端.*d 删除.*\|.*已删除「演示会话」/, "键位在前,消息在后");
	const confirmState = { ...state(), confirm: "删除「演示会话」?会放入系统回收站(可在资源管理器还原)" };
	const confirmFooter = stripAnsi(renderScreen(confirmState).join("\n")).split("\n").filter((line) => line.includes("确认")).pop() ?? "";
	assert.match(confirmFooter, /^\s*y 确认 \/ n 取消 \| 删除「演示会话」/, "确认态同样键位在前");
});

test("renderScreen:搜索态与消息展示", () => {
	const lines = renderScreen(state({ searchMode: true, query: "config", message: "已复制命令" }));
	const text = lines.map(stripAnsi).join("\n");
	assert.match(text, /搜索: config/);
	assert.match(text, /已复制命令/);
});

test("renderScreen:未装拓展时界面不出现任何拓展相关内容", () => {
	const plain = state(); // 该夹具不带 customHints / customBody
	const text = stripAnsi(renderScreen(plain).join("\n"));
	assert.ok(!text.includes("拓展"), "不应出现'拓展'字样");
	assert.ok(!text.includes("分屏"), "不应出现'分屏'字样");
	assert.ok(!text.includes("面板"), "不应出现'面板'字样");
	assert.ok(!text.includes("Enter"), "footer 不再承诺 Enter(其行为取决于状态与拓展)");
});

test("renderScreen:装了拓展时展示拓展自己的键位提示", () => {
	const withHints = { ...state(), customHints: ["Enter 分屏打开"] };
	const text = stripAnsi(renderScreen(withHints).join("\n"));
	assert.ok(text.includes("Enter 分屏打开"), "应展示拓展键位");
});
