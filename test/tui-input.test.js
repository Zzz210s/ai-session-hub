/**
 * 输入泵单测:这是"Esc 到底有没有生效"的关键路径。
 * 回归用例:单独按一次 Esc,必须派发 escape(曾经因为分片保护把孤立的 ESC 直接丢掉了,
 * 导致搜索态没有任何按键能退出去)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInputPump } from "../src/tui-input.ts";

const ESC = "\u001b";

function harness(overrides = {}) {
	const calls = [];
	const ctx = {
		isSearching: () => false,
		setSearching: (v) => calls.push(["setSearching", v]),
		appendQuery: (c) => calls.push(["appendQuery", c]),
		backspaceQuery: () => calls.push(["backspaceQuery"]),
		queryLength: () => 0,
		clearQuery: () => calls.push(["clearQuery"]),
		move: (d) => calls.push(["move", d]),
		jumpTo: (p) => calls.push(["jumpTo", p]),
		setFilter: (k) => calls.push(["setFilter", k]),
		act: (k) => calls.push(["act", k]),
		requestDelete: () => calls.push(["requestDelete"]),
		answerConfirm: (a) => calls.push(["answerConfirm", a]),
		refresh: () => calls.push(["refresh"]),
		quit: (why) => calls.push(["quit", why]),
		redraw: () => calls.push(["redraw"]),
		...overrides,
	};
	return { ctx, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 90));

test("单独一次 Esc:等 40ms 后派发 escape(回归:以前什么都不发生)", async () => {
	const { ctx, calls } = harness({
		isSearching: () => true,
		pendingConfirm: () => undefined,
	});
	const pump = createInputPump({ ctx });
	pump.feed(Buffer.from(ESC, "utf8"));
	await settle();
	pump.dispose();
	assert.deepEqual(calls, [["setSearching", false], ["clearQuery"], ["redraw"]], "搜索态按 Esc = 退出搜索并清空搜索词,而不是退出程序");
});

test("非搜索态按 Esc:派发 escape(由分发器决定=退出)", async () => {
	const { ctx, calls } = harness({ pendingConfirm: () => undefined });
	const pump = createInputPump({ ctx });
	pump.feed(Buffer.from(ESC, "utf8"));
	await settle();
	pump.dispose();
	assert.deepEqual(calls, [["quit", "escape"]]);
});

test("分片到达的 Esc + [B 仍识别为 down,不会误判成 escape", async () => {
	const { ctx, calls } = harness({ pendingConfirm: () => undefined });
	const pump = createInputPump({ ctx });
	pump.feed(Buffer.from(ESC, "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	pump.feed(Buffer.from("[B", "utf8"));
	await settle();
	pump.dispose();
	assert.deepEqual(calls, [["move", 1]]);
});

test("整块到达的方向键与字符键", async () => {
	const { ctx, calls } = harness({ pendingConfirm: () => undefined });
	const pump = createInputPump({ ctx });
	pump.feed(Buffer.from(`${ESC}[A`, "utf8"));
	pump.feed(Buffer.from("3", "utf8"));
	await settle();
	pump.dispose();
	assert.deepEqual(calls, [["move", -1], ["setFilter", "all"], ["redraw"]]);
});

test("拓展消费的输入不进按键分发;dispose 后不再有悬空定时器", async () => {
	const { ctx, calls } = harness({ pendingConfirm: () => undefined });
	const pump = createInputPump({
		ctx,
		extensionHandled: (text) => text.includes("z"),
	});
	pump.feed(Buffer.from("z", "utf8"));
	pump.feed(Buffer.from(ESC, "utf8"));
	await settle();
	pump.dispose();
	assert.deepEqual(calls, [["quit", "escape"]], "被拓展消费的 z 不产生任何动作");
});
