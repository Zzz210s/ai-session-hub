import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSession, planDelete } from "../src/delete.ts";
import { canRecycleToSystem } from "../src/recycle.ts";

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

test("planDelete:Zed(SQLite)禁用删除,避免改坏整个 threads.db", async () => {
	// Zed 的会话 file 就是 threads.db 本身,若不拦会整库进回收站
	const plan = await planDelete(view({ tool: "zed", file: "C:/Zed/threads/threads.db" }));
	assert.equal(plan.supported, false);
	assert.match(plan.reason, /Zed/);
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
	assert.equal(plan.mode, canRecycleToSystem() ? "recycle" : "trash", "默认按平台能力选去向");
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
		// 显式要求走系统回收站:让该用例在任意平台都能验证这条路径
		allowSystemRecycle: true,
		recycle: async (target) => {
			recycled = target;
			// 模拟系统回收站:把文件移走(等价效果)
			await (await import("node:fs/promises")).rm(target);
			return { ok: true };
		},
	});
	assert.equal(result.ok, true);
	assert.equal(recycled, sessionFile, "应把会话文件交给系统回收站");
	assert.match(result.detail, /回收站/);
	assert.match(result.detail, process.platform === "win32" ? /资源管理器还原/ : /文件管理器还原/);
	assert.equal(existsSync(sessionFile), false);
	assert.equal((await readdir(trash).catch(() => [])).length, 0, "走系统回收站时不应再写内部回收目录");
});

test("deleteSession:系统回收站不可用时退回内部回收目录(并说明原因)", async () => {
	const { sessionFile, live, trash } = await fixture();
	const result = await deleteSession(view({ file: sessionFile }), {
		trashDir: trash,
		liveDirectory: live,
		allowSystemRecycle: true,
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

function dshFixture() {
	const dir = mkdtempSync(join(tmpdir(), "ais-dsh-"));
	const sessionDir = join(dir, "sessions", "--C-x--", "s1");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "body.zstd"), "body", "utf8");
	const metaFile = join(dir, "s1.json");
	writeFileSync(metaFile, "{}", "utf8");
	return { dir, sessionDir, metaFile, trash: join(dir, "trash"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test("planDelete:DSH 会话连同元数据条目一起可删", async () => {
	const f = dshFixture();
	const plan = await planDelete({ tool: "dsh", id: "s1", file: f.sessionDir, metaFile: f.metaFile, state: "stored" }, { liveDirectory: join(f.dir, "live") });
	assert.equal(plan.supported, true);
	assert.deepEqual((plan.paths ?? []).sort(), [f.metaFile, f.sessionDir].sort());
	f.cleanup();
});

test("deleteSession:DSH 的会话目录与元数据一起移入内部回收目录", async () => {
	const f = dshFixture();
	const result = await deleteSession({ tool: "dsh", id: "s1", file: f.sessionDir, metaFile: f.metaFile, state: "stored" }, { trashDir: f.trash, allowSystemRecycle: false });
	assert.equal(result.ok, true);
	assert.match(result.detail, /2 项已移入回收目录/);
	assert.equal(existsSync(f.sessionDir), false, "会话目录应已移走");
	assert.equal(existsSync(f.metaFile), false, "元数据条目应已移走");
	assert.equal((await readdir(f.trash)).length, 2, "两项都应落在回收目录");
	f.cleanup();
});

test("deleteSession:系统回收站与内部回收目录都失败时返回失败并说明原因", async () => {
	const { sessionFile, live, root } = await fixture();
	const blocker = join(root, "blocker");
	await writeFile(blocker, "x");
	const result = await deleteSession(view({ file: sessionFile }), {
		trashDir: join(blocker, "trash"),
		liveDirectory: live,
		allowSystemRecycle: true,
		recycle: async () => ({ ok: false, detail: "模拟系统回收站失败" }),
	});
	assert.equal(result.ok, false);
	assert.match(result.detail, /成功 0 项 \/ 失败 1 项/);
	assert.match(result.detail, /模拟系统回收站失败/);
	assert.equal(existsSync(sessionFile), true, "两条退路都失败时不应移走文件");
	assert.equal(existsSync(join(live, "pi-999.json")), true, "失败时不应清心跳");
});

test("deleteSession:DSH 只有一项成功时返回失败并给出计数", async () => {
	const f = dshFixture();
	const blocker = join(f.dir, "blocker");
	writeFileSync(blocker, "x");
	const result = await deleteSession({ tool: "dsh", id: "s1", file: f.sessionDir, metaFile: f.metaFile, state: "stored" }, {
		trashDir: join(blocker, "trash"),
		allowSystemRecycle: true,
		recycle: async (target) => (target === f.sessionDir ? { ok: true } : { ok: false, detail: "模拟系统回收站失败" }),
	});
	assert.equal(result.ok, false);
	assert.match(result.detail, /成功 1 项 \/ 失败 1 项/);
	f.cleanup();
});

test("deleteSession:回收目录重名时追加 -2 后缀", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ais-dsh-dup-"));
	const first = join(dir, "a", "s1");
	const second = join(dir, "b", "s1");
	mkdirSync(join(dir, "a"), { recursive: true });
	mkdirSync(join(dir, "b"), { recursive: true });
	writeFileSync(first, "1");
	writeFileSync(second, "2");
	const trash = join(dir, "trash");
	const result = await deleteSession({ tool: "dsh", id: "s1", file: first, metaFile: second, state: "stored" }, { trashDir: trash, allowSystemRecycle: false });
	assert.equal(result.ok, true);
	const names = (await readdir(trash)).sort();
	assert.equal(names.length, 2);
	assert.match(names[1], /-2$/, "重名项应带 -2 后缀");
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("deleteSession:DSH 只有元数据(file 为空)时仍可删除", async () => {
	const f = dshFixture();
	const result = await deleteSession({ tool: "dsh", id: "s1", file: "", metaFile: f.metaFile, state: "stored" }, { trashDir: f.trash, allowSystemRecycle: false });
	assert.equal(result.ok, true);
	assert.equal(existsSync(f.metaFile), false, "元数据条目应已移走");
	assert.equal((await readdir(f.trash)).length, 1, "应只移动元数据一项");
	f.cleanup();
});
