/**
 * TUI 动作层单测:只走无副作用的分支(选中/移动/交给拓展/兜底提示)。
 * 复制与聚焦会真的碰剪贴板与窗口,故不在单测里触发。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTuiActions } from "../src/tui-actions.ts";

const row = (id, state = "stored") => ({ tool: "pi", id, name: id.toUpperCase(), state, attention: false });

function harness(rows, overrides = {}) {
	const calls = { notify: [], redraw: 0, reload: 0 };
	let cursor = 0;
	const actions = createTuiActions({
		rows: () => rows,
		cursorIndex: () => cursor,
		setCursorIndex: (index) => {
			cursor = index;
		},
		screen: {},
		reload: async () => {
			calls.reload++;
		},
		notify: (text) => calls.notify.push(text),
		redraw: () => {
			calls.redraw++;
		},
		extensions: [],
		extensionContext: () => ({ marker: "ctx" }),
		...overrides,
	});
	return { actions, calls, cursorNow: () => cursor };
}

test("selected:光标超出可见行数时夹到末行", () => {
	const rows = [row("a"), row("b")];
	const { actions } = harness(rows);
	assert.equal(actions.selected()?.id, "a");
	assert.equal(harness(rows, { cursorIndex: () => 99 }).actions.selected()?.id, "b");
	assert.equal(harness([]).actions.selected(), undefined, "空列表返回 undefined");
});

test("move:两端夹紧,并且每次都重绘", () => {
	const { actions, calls, cursorNow } = harness([row("a"), row("b"), row("c")]);
	actions.move(1);
	actions.move(1);
	actions.move(1);
	assert.equal(cursorNow(), 2, "底部不再越过");
	assert.equal(calls.redraw, 3);
	actions.move(-5);
	assert.equal(cursorNow(), 0, "顶部不再越过");
});

test("act:没有可见行时什么都不做", async () => {
	const { actions, calls } = harness([]);
	await actions.act("smart");
	assert.deepEqual(calls.notify, []);
	assert.equal(calls.redraw, 0);
});

test("act(smart):历史会话没有拓展可开时给兜底提示", async () => {
	const { actions, calls } = harness([row("a")]);
	await actions.act("smart");
	assert.deepEqual(calls.notify, ["该会话未运行:按 a 接管终端继续"]);
	assert.equal(calls.redraw, 1);
});

test("act(smart):有拓展时交给拓展打开,并传入拓展上下文", async () => {
	const seen = [];
	const opener = { openSelected: async (ctx) => seen.push(ctx) };
	const { actions, calls } = harness([row("a")], { extensions: [opener] });
	await actions.act("smart");
	assert.deepEqual(seen, [{ marker: "ctx" }]);
	assert.deepEqual(calls.notify, [], "交给拓展后不应再提示");
});
