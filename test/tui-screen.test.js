import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createTuiScreen } from "../src/tui-screen.ts";

/** 伪造 stdin/stdout:记录写入、监听器与 raw 模式变化 */
function fakeStreams() {
	const writes = [];
	const stdout = Object.assign(new EventEmitter(), {
		write: (chunk) => {
			writes.push(String(chunk));
			return true;
		},
	});
	const stdin = Object.assign(new EventEmitter(), {
		rawModes: [],
		paused: 0,
		resumed: 0,
		setRawMode(value) {
			this.rawModes.push(value);
			return this;
		},
		pause() {
			this.paused++;
			return this;
		},
		resume() {
			this.resumed++;
			return this;
		},
	});
	return { stdout, stdin, writes };
}

test("draw:写入整屏,内容未变时跳过,force 时重绘", () => {
	const { stdout, stdin, writes } = fakeStreams();
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.draw(["a", "b"], "sig-1");
	assert.equal(writes.length, 1);
	assert.ok(writes[0].includes("a\r\nb"));
	screen.draw(["a", "b"], "sig-1");
	assert.equal(writes.length, 1, "签名相同应跳过重绘");
	screen.draw(["a", "b"], "sig-1", true);
	assert.equal(writes.length, 2, "force 应强制重绘");
});

test("suspend:挂起后不再写屏(与会话抢屏的根因)", () => {
	const { stdout, stdin, writes } = fakeStreams();
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.enter();
	const before = writes.length;
	screen.suspend();
	assert.equal(screen.suspended, true);
	screen.draw(["x"], "sig-2", true);
	screen.draw(["y"], "sig-3", true);
	assert.equal(writes.length, before, "挂起期间任何绘制都必须被忽略");
});

test("suspend:停止计时器并摘掉 resize/stdin 监听、退出 raw 模式", () => {
	const { stdout, stdin } = fakeStreams();
	let ticks = 0;
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.enter();
	assert.equal(stdin.listenerCount("data"), 1);
	assert.equal(stdout.listenerCount("resize"), 1);
	screen.startTicker(() => ticks++, 10);
	screen.suspend();
	assert.equal(stdin.listenerCount("data"), 0, "挂起应摘掉 stdin 监听");
	assert.equal(stdout.listenerCount("resize"), 0, "挂起应摘掉 resize 监听");
	assert.equal(stdin.rawModes.at(-1), false, "挂起应退出 raw 模式");
	assert.equal(stdin.paused, 1);
	screen.stopTicker();
});

test("resume:恢复监听、raw 模式并立即重绘", () => {
	const { stdout, stdin, writes } = fakeStreams();
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.enter();
	screen.suspend();
	const before = writes.length;
	screen.resume();
	assert.equal(screen.suspended, false);
	assert.equal(stdin.listenerCount("data"), 1);
	assert.equal(stdout.listenerCount("resize"), 1);
	assert.equal(stdin.rawModes.at(-1), true);
	assert.ok(writes.length > before, "恢复时应重绘");
});

test("handOff:退出备用屏、打印提示并挂起", () => {
	const { stdout, stdin, writes } = fakeStreams();
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.enter();
	screen.handOff("正在接管终端: pi --session x");
	assert.equal(screen.suspended, true);
	const text = writes.join("");
	assert.ok(text.includes("\u001b[?1049l"), "应退出备用屏");
	assert.ok(text.includes("正在接管终端"), "应打印提示");
	assert.ok(text.includes("\u001b[?25h"), "应恢复光标");
});

test("leave:停止计时器、摘监听并打印结束信息", () => {
	const { stdout, stdin, writes } = fakeStreams();
	const screen = createTuiScreen({ stdin, stdout, onData: () => {}, onResize: () => {} });
	screen.enter();
	screen.leave("已退出");
	assert.equal(stdin.listenerCount("data"), 0);
	assert.equal(stdout.listenerCount("resize"), 0);
	assert.ok(writes.join("").includes("已退出"));
});
