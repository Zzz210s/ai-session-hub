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
	assert.deepEqual(calls.notify, ["该会话未运行:按 a 在新窗口继续(Shift+a 就地接管)"]);
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

const guiRow = (tool, id, name) => ({ tool, id, name, state: "stored", attention: false, kind: "gui" });

test("act:GUI 会话按 Enter 走聚焦(而不是接管终端)", async () => {
	const calls = [];
	const { actions } = harness([guiRow("zed", "t1", "线程")], {
		focusApp: async (tool) => {
			calls.push(["focusApp", tool]);
			return { ok: true, detail: "已聚焦 Zed" };
		},
	});
	await actions.act("smart");
	assert.deepEqual(calls, [["focusApp", "zed"]]);
});

test("act:GUI 会话按 f 同样只聚焦窗口", async () => {
	const focused = [];
	const { actions, calls } = harness([guiRow("zed", "t1", "线程")], {
		focusApp: async (tool) => {
			focused.push(["focusApp", tool]);
			return { ok: true, detail: "已聚焦 Zed 窗口" };
		},
	});
	await actions.act("focus");
	assert.deepEqual(focused, [["focusApp", "zed"]]);
	assert.deepEqual(calls.notify, ["已聚焦 Zed 窗口"]);
});

test("act:GUI 会话按 a(接管)给出明确提示", async () => {
	const { actions, calls } = harness([guiRow("dsh", "s1", "会话")]);
	await actions.act("attach");
	assert.deepEqual(calls.notify, ["DeepSeek Harness 是 GUI 应用:没有终端可接管,按 Enter/f 聚焦窗口"]);
});

test("act:GUI 会话按 c 复制会话信息(而不是恢复命令)", async () => {
	const copied = [];
	const { actions, calls } = harness([guiRow("zed", "t1", "线程")], {
		copySessionInfo: async (view) => {
			copied.push(view.id);
			return { ok: true, detail: "已复制: 会话信息" };
		},
	});
	await actions.act("copy");
	assert.deepEqual(copied, ["t1"]);
	assert.deepEqual(calls.notify, ["已复制: 会话信息"]);
});

test("act(attach):不支持的会话类型只提示,不抛异常(防止 unhandled rejection 把看板带走)", async () => {
	// dsh/zed 之类 GUI 会话走 openSession 的"暂不支持"分支:不 spawn 任何进程,可以放心单测
	const gui = { tool: "dsh", kind: "cli", id: "d1", name: "DSH", state: "stored", attention: false };
	const { actions, calls } = harness([gui]);
	await actions.act("attach");
	assert.equal(calls.notify.length, 1);
	assert.match(calls.notify[0], /暂不支持|打开失败/);
});

test("act(attach):把选中会话交给 openSession,并把结果写进提示行", async () => {
	const rows = [{ tool: "pi", kind: "cli", id: "s1", name: "历史会话", state: "stored", attention: false, file: "C:/sessions/s1.jsonl" }];
	const seen = [];
	const { actions, calls } = harness(rows, {
		openSession: async (view) => {
			seen.push(view.id);
			return { ok: true, detail: "已在新窗口启动: pi --session s1.jsonl" };
		},
	});
	await actions.act("attach");
	assert.deepEqual(seen, ["s1"]);
	assert.equal(calls.notify.pop(), "已在新窗口启动: pi --session s1.jsonl");
});

test("act(attach):运行中的会话只切窗口,不重复 resume", async () => {
	const rows = [{ tool: "pi", kind: "cli", id: "r1", name: "运行中", state: "running", attention: false, live: { tab: { windowPid: 1, index: 0, title: "x", selected: true, hwnd: "1", windowTitle: "" } } }];
	let opened = 0;
	const { actions, calls } = harness(rows, {
		openSession: async () => {
			opened++;
			return { ok: true, detail: "opened" };
		},
		focusApp: async () => ({ ok: true, detail: "focused" }),
	});
	await actions.act("attach");
	assert.equal(opened, 0, "不该再起一个进程");
	assert.match(calls.notify.pop(), /正在运行/);
});
