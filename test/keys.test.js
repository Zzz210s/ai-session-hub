import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKeys } from "../src/keys.ts";

const names = (buffer) => parseKeys(buffer).keys.map((key) => (typeof key === "object" ? key.char : key));

test("parseKeys:CSI 方向键", () => {
	assert.deepEqual(names("\u001b[A"), ["up"]);
	assert.deepEqual(names("\u001b[B"), ["down"]);
	assert.deepEqual(names("\u001b[C"), ["right"]);
	assert.deepEqual(names("\u001b[D"), ["left"]);
	assert.deepEqual(names("\u001b[A\u001b[B\u001b[B"), ["up", "down", "down"]);
});

test("parseKeys:SS3 方向键(部分终端/ConPTY 的形式)", () => {
	assert.deepEqual(names("\u001bOA"), ["up"]);
	assert.deepEqual(names("\u001bOB"), ["down"]);
	assert.deepEqual(names("\u001bOA\u001bOB"), ["up", "down"]);
});

test("parseKeys:翻页/首尾/删除", () => {
	assert.deepEqual(names("\u001b[5~"), ["pageup"]);
	assert.deepEqual(names("\u001b[6~"), ["pagedown"]);
	assert.deepEqual(names("\u001b[H"), ["home"]);
	assert.deepEqual(names("\u001b[F"), ["end"]);
	assert.deepEqual(names("\u001b[3~"), ["backspace"]);
});

test("parseKeys:带修饰键的方向键(如 shift+↑)", () => {
	assert.deepEqual(names("\u001b[1;2A"), ["up"]);
	assert.deepEqual(names("\u001b[1;5B"), ["down"]);
});

test("parseKeys:控制键与普通字符", () => {
	assert.deepEqual(names("\r"), ["enter"]);
	assert.deepEqual(names("\n"), ["enter"]);
	assert.deepEqual(names("\u007f"), ["backspace"]);
	assert.deepEqual(names("\u0003"), ["quit"]);
	assert.deepEqual(names("abc"), ["a", "b", "c"]);
	assert.deepEqual(names("/config 1"), ["/", "c", "o", "n", "f", "i", "g", " ", "1"]);
});

test("parseKeys:分片安全 —— 不完整的转义序列留在 rest,不误判为退出", () => {
	const first = parseKeys("\u001b");
	assert.deepEqual(first.keys, []);
	assert.equal(first.rest, "\u001b");

	const second = parseKeys("\u001b[");
	assert.deepEqual(second.keys, []);
	assert.equal(second.rest, "\u001b[");

	// 分两片到达:先 ESC,再 [B —— 拼接后应识别为 down
	const part1 = parseKeys("\u001b");
	const part2 = parseKeys(`${part1.rest}[B`);
	assert.deepEqual(part2.keys, ["down"]);
	assert.equal(part2.rest, "");
});

test("parseKeys:真正的 ESC(后面跟普通字符)按退出处理", () => {
	assert.deepEqual(names("\u001bq"), ["escape", "q"]);
});
