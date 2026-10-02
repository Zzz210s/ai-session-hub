/**
 * 回收站(Windows 侧只测纯函数;freedesktop 部分用临时目录真实跑一遍)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeTrashPath, pickTrashName, recycleToTrashLinux, trashRoot } from "../src/recycle.ts";

test("pickTrashName:重名时按规范追加 .1 .2", () => {
	assert.equal(pickTrashName("a.jsonl", () => false), "a.jsonl");
	const taken = new Set(["a.jsonl", "a.jsonl.1"]);
	assert.equal(pickTrashName("a.jsonl", (name) => taken.has(name)), "a.jsonl.2");
});

test("encodeTrashPath:保留路径分隔符,编码空格与井号", () => {
	assert.equal(encodeTrashPath("/home/u/my sessions/a.jsonl"), "/home/u/my%20sessions/a.jsonl");
	assert.equal(encodeTrashPath("/tmp/a#b"), "/tmp/a%23b");
});

test("trashRoot:优先 XDG_DATA_HOME", () => {
	assert.equal(trashRoot({ XDG_DATA_HOME: "/data" }), join("/data", "Trash"));
	assert.ok(trashRoot({}).endsWith(join(".local", "share", "Trash")));
});

test("recycleToTrashLinux:文件进 files/,元数据进 info/(可还原)", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-trash-"));
	const trash = join(root, "Trash");
	const workdir = join(root, "sessions");
	mkdirSync(workdir, { recursive: true });
	const victim = join(workdir, "2026-09-02T09-46-31.jsonl");
	writeFileSync(victim, "会话内容", "utf8");

	const result = recycleToTrashLinux(victim, trash);
	assert.equal(result.ok, true, result.detail);
	assert.equal(existsSync(victim), false, "原位置应已不存在");
	assert.equal(existsSync(join(trash, "files", "2026-09-02T09-46-31.jsonl")), true, "文件在回收站里");
	const info = readFileSync(join(trash, "info", "2026-09-02T09-46-31.jsonl.trashinfo"), "utf8");
	assert.match(info, /^\[Trash Info\]/);
	assert.match(info, new RegExp(`Path=${encodeTrashPath(victim).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(info, /DeletionDate=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("recycleToTrashLinux:同名不覆盖,自动改名", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-trash2-"));
	const trash = join(root, "Trash");
	for (const round of [1, 2]) {
		const workdir = join(root, `round${round}`);
		mkdirSync(workdir, { recursive: true });
		const victim = join(workdir, "same.jsonl");
		writeFileSync(victim, `内容${round}`, "utf8");
		assert.equal(recycleToTrashLinux(victim, trash).ok, true);
	}
	assert.equal(readFileSync(join(trash, "files", "same.jsonl"), "utf8"), "内容1");
	assert.equal(readFileSync(join(trash, "files", "same.jsonl.1"), "utf8"), "内容2");
});

test("recycleToTrashLinux:源文件不存在时报告失败(调用方会退回内部回收目录)", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-trash3-"));
	const result = recycleToTrashLinux(join(root, "nope.jsonl"), join(root, "Trash"));
	assert.equal(result.ok, false);
	assert.ok(result.detail && result.detail.length > 0);
});
