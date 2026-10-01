/**
 * 会话名查找(增量/受限读取路径)单测:
 *  - 文件长得长了,只看新增的字节
 *  - 新增里没有 session_info 时沿用上一次的名字
 *  - 名字只在文件开头时,不必全文扫描也能拿到
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSessionName } from "../src/scan/pi.ts";

const info = (name) => `${JSON.stringify({ type: "session_info", name, timestamp: "2026-10-01T10:00:00.000Z" })}\n`;
const filler = (count, bytes = 400) => `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(bytes) } })}\n`.repeat(count);

function tempFile(content) {
	const dir = mkdtempSync(join(tmpdir(), "ais-name-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, content, "utf8");
	return file;
}

test("名字在文件开头:不需要全文扫描也能取到", async () => {
	const file = tempFile(info("开头命名") + filler(200));
	assert.equal(await findSessionName(file, 999_999), "开头命名");
});

test("名字在文件末尾:取最后一条", async () => {
	const file = tempFile(filler(50) + info("旧名字") + filler(50) + info("最新名字"));
	assert.equal(await findSessionName(file, 999_999), "最新名字");
});

test("没有任何 session_info 时返回 undefined", async () => {
	const file = tempFile(filler(20));
	assert.equal(await findSessionName(file, 999_999), undefined);
});

test("无上次记录时,新增段没有 session_info 就沿用旧名字(增量路径)", async () => {
	const file = tempFile(info("曾用名") + filler(5));
	appendFileSync(file, filler(5), "utf8"); // 追加但无 session_info
	assert.equal(await findSessionName(file, 999_999, "曾用名"), "曾用名");
});

test("无头尾命中时也能拿到中间的名字(逆向块读)", async () => {
	// 名字埋在中间,前后都有大量内容;靠"尾部 8MB + 头部 256KB"两条路各覆盖一段
	const file = tempFile(filler(1000) + info("中间的名字") + filler(1000));
	assert.equal(await findSessionName(file, 999_999), "中间的名字");
});
