import assert from "node:assert/strict";
import { test } from "node:test";
import { clampLine, displayWidth, renderScreen, sanitizeForDisplay, stripAnsi } from "../src/tui-view.ts";

const NOW = new Date("2026-09-21T12:00:00Z");

function sampleRow(overrides = {}) {
	return {
		tool: "pi",
		id: "abcdef123456",
		file: "C:/sessions/2026-09-10T15-02-39-585Z_01a08bd7-a0df-7704-988d-4f7f8fcb913c.jsonl",
		cwd: "C:\\Users\\me\\一个很长的项目目录名\\config-ai",
		name: "一个相当长的中文会话名称用于测试截断行为",
		topic: "一个相当长的中文会话名称用于测试截断行为",
		firstMessage: "",
		createdAt: new Date("2026-09-21T09:00:00Z"),
		updatedAt: new Date("2026-09-21T11:57:00Z"),
		state: "running",
		status: "working",
		attention: false,
		live: { tab: { windowPid: 19452, index: 4, title: "◐ x", selected: true, hwnd: "1", windowTitle: "" } },
		...overrides,
	};
}

function stateFor(width, height, extra = {}) {
	const rows = [
		sampleRow(),
		sampleRow({ id: "b", name: "历史会话", state: "stored", status: undefined, attention: true, live: undefined }),
	];
	return {
		rows,
		totals: { all: 2, running: 1, attention: 1, stored: 1 },
		filter: "all",
		query: "测试",
		searchMode: true,
		cursor: 0,
		width,
		height,
		refreshedAt: NOW,
		now: NOW,
		...extra,
	};
}

test("clampLine:超宽行被截断且保留 ANSI", () => {
	const line = "\u001b[1m" + "字".repeat(40) + "\u001b[0m";
	const clamped = clampLine(line, 20);
	assert.equal(displayWidth(stripAnsi(clamped)), 20);
	assert.ok(clamped.startsWith("\u001b[1m"));
	assert.ok(clamped.endsWith("\u001b[0m"));
});

test("clampLine:未超宽时原样保留可见内容", () => {
	const line = "abc 中文";
	assert.equal(stripAnsi(clampLine(line, 40)), "abc 中文");
});

test("renderScreen:任何一行都不超过终端宽度(多尺寸)", () => {
	for (const [width, height] of [
		[60, 20],
		[80, 24],
		[100, 30],
		[120, 36],
		[160, 50],
		[226, 63],
		[300, 80],
	]) {
		const lines = renderScreen(stateFor(width, height));
		assert.equal(lines.length, height, `行数应为终端高度 (${width}x${height})`);
		for (const [index, line] of lines.entries()) {
			const visible = stripAnsi(line);
			const w = displayWidth(visible);
			assert.ok(w <= width, `${width}x${height} 第 ${index} 行超宽: ${w} > ${width} :: ${visible.slice(0, 80)}`);
		}
	}
});

test("renderScreen:窄终端(60 列)也能正常排版且不含制表符", () => {
	const lines = renderScreen(stateFor(60, 20)).map(stripAnsi);
	assert.ok(lines.every((line) => !line.includes("\t")));
	assert.match(lines.join("\n"), /AI 会话总览/);
});

test("renderScreen:不使用宽度不确定的符号(避免字体把 ◐▸· 当双宽导致错位)", () => {
	const text = renderScreen(stateFor(120, 30)).map(stripAnsi).join("\n");
	const ambiguous = [...text].filter((ch) => "◐◑◒◓▸·×…│┌┐└┘─".includes(ch));
	assert.deepEqual(ambiguous, [], `发现宽度不确定字符: ${ambiguous.join("")}`);
});

test("sanitizeForDisplay:宽度不确定字符换成 ASCII 等价物", () => {
	assert.equal(sanitizeForDisplay("◐ 任务 · 说明"), "o 任务 - 说明");
	assert.equal(sanitizeForDisplay("▸ bash × 429 …"), "> bash x 429 ...");
	assert.equal(sanitizeForDisplay("中文标题"), "中文标题");
});

test("renderScreen:选中行整行反显(反显区间覆盖整列,不被行内 RESET 打断)", () => {
	const lines = renderScreen(stateFor(120, 24));
	const body = lines.slice(2, 22);
	const selectedLine = body.find((line) => line.includes("[7m"));
	assert.ok(selectedLine, "应有选中行带反显");
	// 反显应从行首开始,且覆盖整个左栏(按可见宽度衡量,不能按字符数)
	const start = selectedLine.indexOf("[7m");
	assert.equal(start, 0, "反显应从行首开始(整列高亮)");
	const afterReverse = selectedLine.slice(start + "[7m".length);
	const end = afterReverse.indexOf("[0m");
	assert.ok(end > 0, "反显区间应有结束的 RESET");
	const reversedVisible = displayWidth(stripAnsi(afterReverse.slice(0, end)));
	const leftWidth = Math.min(52, Math.max(30, Math.floor((120 - 1) * 0.45)));
	assert.equal(reversedVisible, leftWidth, `反显应覆盖整个左栏(${reversedVisible} vs ${leftWidth})`);
	// 未选中行不带反显
	const plain = body.filter((line) => !line.includes("[7m"));
	assert.ok(plain.length >= 1, "其余行不应带反显");
});

test("renderScreen:光标下移后反显位置随之下移", () => {
	const first = renderScreen(stateFor(120, 24));
	const second = renderScreen({ ...stateFor(120, 24), cursor: 1 });
	const indexOfReverse = (lines) => lines.findIndex((line, i) => i >= 2 && line.includes("[7m"));
	assert.equal(indexOfReverse(second) - indexOfReverse(first), 1, "反显应随光标下移一行");
});
