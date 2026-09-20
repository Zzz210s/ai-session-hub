import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSession, planDelete } from "../src/delete.ts";

const view = (overrides = {}) => ({
	tool: "pi",
	id: "sess-1",
	file: "",
	cwd: "C:/work",
	name: "demo",
	topic: "demo",
	firstMessage: "",
	createdAt: new Date(),
	updatedAt: new Date(),
	state: "stored",
	attention: false,
	...overrides,
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ais-delete-"));
	const sessionFile = join(root, "session.jsonl");
	await writeFile(sessionFile, '{"type":"session"}\n');
	const live = join(root, "live");
	await mkdir(live, { recursive: true });
	await writeFile(join(live, "pi-999.json"), JSON.stringify({ tool: "pi", pid: 999, sessionId: "sess-1" }));
	await writeFile(join(live, "pi-111.json"), JSON.stringify({ tool: "pi", pid: 111, sessionId: "other" }));
	return { root, sessionFile, live, trash: join(root, "trash") };
}

test("planDelete:运行中的会话不可删除(避免破坏正在写入的文件)", async () => {
	const plan = await planDelete(view({ state: "running" }));
	assert.equal(plan.supported, false);
	assert.match(plan.reason, /正在运行/);
});

test("planDelete:opencode(SQLite)暂不支持", async () => {
	const plan = await planDelete(view({ tool: "opencode", file: "C:/db.sqlite" }));
	assert.equal(plan.supported, false);
	assert.match(plan.reason, /SQLite/);
});

test("planDelete:文件缺失时不可删除", async () => {
	const plan = await planDelete(view({ file: "C:/nope/missing.jsonl" }));
	assert.equal(plan.supported, false);
	assert.match(plan.reason, /不存在/);
});

test("planDelete:可删除时会给出路径、去向与需清理的心跳记录", async () => {
	const { sessionFile, live } = await fixture();
	const plan = await planDelete(view({ file: sessionFile }), { liveDirectory: live });
	assert.equal(plan.supported, true);
	assert.equal(plan.mode, "recycle", "默认走系统回收站");
	assert.equal(plan.path, sessionFile);
	assert.equal(plan.heartbeatFiles.length, 1, "只清理 sessionId 匹配的那条");
	assert.match(plan.heartbeatFiles[0], /pi-999\.json$/);
});

test("deleteSession:优先送系统回收站(不硬删除)", async () => {
	const { sessionFile, live, trash } = await fixture();
	let recycled = "";
	const result = await deleteSession(view({ file: sessionFile }), {
		trashDir: trash,
		liveDirectory: live,
		recycle: async (target) => {
			recycled = target;
			// 模拟系统回收站:把文件移走(等价效果)
			await (await import("node:fs/promises")).rm(target);
			return { ok: true };
		},
	});
	assert.equal(result.ok, true);
	assert.equal(recycled, sessionFile, "应把会话文件交给系统回收站");
	assert.match(result.detail, /系统回收站/);
	assert.match(result.detail, /资源管理器还原/);
	assert.equal(existsSync(sessionFile), false);
	assert.equal((await readdir(trash).catch(() => [])).length, 0, "走系统回收站时不应再写内部回收目录");
});

test("deleteSession:系统回收站不可用时退回内部回收目录(并说明原因)", async () => {
	const { sessionFile, live, trash } = await fixture();
	const result = await deleteSession(view({ file: sessionFile }), {
		trashDir: trash,
		liveDirectory: live,
		recycle: async () => ({ ok: false, detail: "模拟失败" }),
	});
	assert.equal(result.ok, true);
	assert.match(result.detail, /回收目录/);
	assert.match(result.detail, /模拟失败/, "应说明退回原因");
	assert.equal(existsSync(sessionFile), false, "原文件应已移走");
	const moved = await readdir(trash);
	assert.equal(moved.length, 1, "回收目录里应有 1 个文件");
	assert.match(moved[0], /^.*__pi__session\.jsonl$/, "文件名带时间戳与工具名");
	assert.equal(await readFile(join(trash, moved[0]), "utf8"), '{"type":"session"}\n', "内容未变,可恢复");
	const remaining = await readdir(live);
	assert.deepEqual(remaining, ["pi-111.json"], "无关心跳记录应保留");
});
