import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchKey } from "../src/tui-keys.ts";

function fakeContext(overrides = {}) {
	const calls = [];
	const ctx = {
		calls,
		searching: false,
		isSearching() {
			return this.searching;
		},
		setSearching(value) {
			this.searching = value;
			calls.push(`search:${value}`);
		},
		appendQuery(char) {
			this.query += char;
			calls.push(`query+${char}`);
		},
		query: "",
		queryLength() {
			return this.query.length;
		},
		backspaceQuery() {
			this.query = this.query.slice(0, -1);
			calls.push("query-backspace");
		},
		clearQuery() {
			this.query = "";
			calls.push("query-clear");
		},
		move(delta) {
			calls.push(`move:${delta}`);
		},
		jumpTo(position) {
			calls.push(`jump:${position}`);
		},
		setFilter(kind) {
			calls.push(`filter:${kind}`);
		},
		async act(kind) {
			calls.push(`act:${kind}`);
		},
		async refresh() {
			calls.push("refresh");
		},
		quit(why) {
			calls.push(`quit:${why}`);
		},
		redraw() {
			calls.push("redraw");
		},
		...overrides,
	};
	return ctx;
}

test("dispatchKey:方向键与翻页移动光标", async () => {
	const ctx = fakeContext();
	await dispatchKey("up", ctx);
	await dispatchKey("down", ctx);
	await dispatchKey("pageup", ctx);
	await dispatchKey("pagedown", ctx);
	await dispatchKey("home", ctx);
	await dispatchKey("end", ctx);
	assert.deepEqual(ctx.calls, ["move:-1", "move:1", "move:-10", "move:10", "jump:top", "jump:bottom"]);
});

test("dispatchKey:j/k 也能移动(vim 风格)", async () => {
	const ctx = fakeContext();
	await dispatchKey({ char: "j" }, ctx);
	await dispatchKey({ char: "k" }, ctx);
	assert.deepEqual(ctx.calls, ["move:1", "move:-1"]);
});

test("dispatchKey:数字键切换筛选", async () => {
	const ctx = fakeContext();
	await dispatchKey({ char: "1" }, ctx);
	await dispatchKey({ char: "2" }, ctx);
	await dispatchKey({ char: "3" }, ctx);
	await dispatchKey({ char: "4" }, ctx);
	assert.deepEqual(ctx.calls, ["filter:running", "redraw", "filter:attention", "redraw", "filter:all", "redraw", "filter:stored", "redraw"]);
});

test("dispatchKey:动作键与退出", async () => {
	const ctx = fakeContext();
	await dispatchKey({ char: "a" }, ctx);
	await dispatchKey({ char: "f" }, ctx);
	await dispatchKey({ char: "c" }, ctx);
	await dispatchKey("enter", ctx);
	await dispatchKey({ char: "q" }, ctx);
	await dispatchKey("quit", ctx);
	assert.deepEqual(ctx.calls, ["act:attach", "act:focus", "act:copy", "act:smart", "quit:q", "quit:ctrl-c"]);
});

test("dispatchKey:搜索态下字符进入查询而非触发动作", async () => {
	const ctx = fakeContext();
	await dispatchKey({ char: "/" }, ctx);
	assert.equal(ctx.searching, true);
	await dispatchKey({ char: "a" }, ctx);
	await dispatchKey({ char: "b" }, ctx);
	await dispatchKey("backspace", ctx);
	assert.deepEqual(ctx.calls, ["search:true", "redraw", "query+a", "redraw", "query+b", "redraw", "query-backspace", "redraw"]);
});

test("dispatchKey:搜索词已删空时再按 Backspace 退出搜索(第二条退出路径)", async () => {
	const ctx = fakeContext();
	ctx.searching = true;
	ctx.query = "";
	await dispatchKey("backspace", ctx);
	assert.deepEqual(ctx.calls, ["search:false", "redraw"], "删空后再按一次 = 退出搜索");

	const withText = fakeContext();
	withText.searching = true;
	withText.query = "abc";
	await dispatchKey("backspace", withText);
	assert.deepEqual(withText.calls, ["query-backspace", "redraw"], "还有字时只删字,不退出");
});

test("dispatchKey:搜索态下 Enter 结束搜索,ESC 结束搜索并清空", async () => {
	const ctx = fakeContext();
	ctx.searching = true;
	await dispatchKey("enter", ctx);
	assert.deepEqual(ctx.calls, ["search:false", "redraw"]);

	const ctx2 = fakeContext();
	ctx2.searching = true;
	await dispatchKey("escape", ctx2);
	assert.deepEqual(ctx2.calls, ["search:false", "query-clear", "redraw"]);
});

test("dispatchKey:非搜索态 ESC 退出程序", async () => {
	const ctx = fakeContext();
	await dispatchKey("escape", ctx);
	assert.deepEqual(ctx.calls, ["quit:escape"]);
});

test("dispatchKey:待确认操作只接受 y / n / Esc", async () => {
	const ctx = fakeContext();
	ctx.pendingConfirm = () => "删除?y/n";
	const answers = [];
	ctx.answerConfirm = (accepted) => answers.push(accepted);
	await dispatchKey({ char: "x" }, ctx);      // 其它键被忽略
	await dispatchKey("down", ctx);
	assert.equal(answers.length, 0);
	await dispatchKey({ char: "y" }, ctx);
	await dispatchKey({ char: "n" }, ctx);
	await dispatchKey("escape", ctx);
	assert.deepEqual(answers, [true, false, false]);
});

test("dispatchKey:d 键请求删除", async () => {
	const ctx = fakeContext();
	let requested = 0;
	ctx.pendingConfirm = () => undefined;
	ctx.requestDelete = () => requested++;
	await dispatchKey({ char: "d" }, ctx);
	assert.equal(requested, 1);
});
