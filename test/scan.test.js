import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeSession } from "../src/scan/claude.ts";
import { parsePiSession } from "../src/scan/pi.ts";
import { looksLikePayload, toSnippet } from "../src/scan/io.ts";

async function fixture(lines) {
	const dir = await mkdtemp(join(tmpdir(), "ais-test-"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

test("parsePiSession:读取头信息、名称与首条用户消息", async () => {
	const file = await fixture([
		JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-09-20T10:00:00.000Z", cwd: "C:\\work\\proj" }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我重构登录模块" }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } }),
		JSON.stringify({ type: "session_info", name: "重构登录", timestamp: "2026-09-20T10:05:00.000Z" }),
	]);
	const record = await parsePiSession(file);
	assert.equal(record?.tool, "pi");
	assert.equal(record?.id, "pi-1");
	assert.equal(record?.cwd, "C:\\work\\proj");
	assert.equal(record?.name, "重构登录");
	assert.equal(record?.topic, "重构登录");
	assert.equal(record?.firstMessage, "帮我重构登录模块");
	assert.equal(record?.createdAt.toISOString(), "2026-09-20T10:00:00.000Z");
});

test("parsePiSession:缺头信息时用文件名推断 id", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-test-"));
	const file = join(dir, "2026-09-20T10-00-00-000Z_abcd-1234.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`, "utf8");
	const record = await parsePiSession(file);
	assert.equal(record?.id, "abcd-1234");
	assert.equal(record?.firstMessage, "hi");
});

test("parseClaudeSession:跳过机器载荷,取摘要与真实话题", async () => {
	const file = await fixture([
		JSON.stringify({ type: "mode", sessionId: "claude-1" }),
		JSON.stringify({ type: "user", cwd: "C:\\work\\shop", timestamp: "2026-09-20T11:00:00.000Z", message: { role: "user", content: '{"env":{"A":"1"}}' } }),
		JSON.stringify({ type: "user", cwd: "C:\\work\\shop", timestamp: "2026-09-20T11:01:00.000Z", message: { role: "user", content: "修复支付回调" } }),
		JSON.stringify({ type: "summary", summary: "支付回调修复" }),
	]);
	const record = await parseClaudeSession(file);
	assert.equal(record?.tool, "claude");
	assert.equal(record?.id, "claude-1");
	assert.equal(record?.cwd, "C:\\work\\shop");
	assert.equal(record?.firstMessage, "修复支付回调");
	assert.equal(record?.topic, "支付回调修复");
	assert.equal(record?.name, "支付回调修复");
});

test("io:载荷识别与摘要压缩", () => {
	assert.equal(looksLikePayload('{"a":1}'), true);
	assert.equal(looksLikePayload("<command-name>hi</command-name>"), true);
	assert.equal(looksLikePayload("修复支付回调"), false);
	assert.equal(looksLikePayload(""), true);
	assert.equal(toSnippet("a\n\nb   c"), "a b c");
	assert.match(toSnippet("x".repeat(100), 10), /…$/);
});
