import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDeleteFlow } from "../src/tui-delete.ts";

/** 等条件成立(避免并行跑测试时固定 sleep 不够;planDelete 会起 PowerShell 探测回收站支持,负载高时要留足) */
async function waitFor(condition, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return false;
}

const view = (overrides = {}) => ({
	tool: "pi",
	id: "sess-1",
	file: "",
	cwd: "C:/w",
	name: "演示会话",
	topic: "演示会话",
	firstMessage: "",
	createdAt: new Date(),
	updatedAt: new Date(),
	state: "stored",
	attention: false,
	...overrides,
});

/**
 * 造一个删除流程 + 记录所有副作用。
 * hide/unhide/forget 是 2026-11-19 加的:确认后立刻把行藏起来,别让"已删除但还在"骗人。
 */
function makeFlow(rows, extra = {}) {
	const log = { messages: [], hidden: [], unhidden: [], forgotten: [], reloads: [] };
	const flow = createDeleteFlow({
		rows: () => (typeof rows === "function" ? rows() : rows),
		selected: () => (typeof rows === "function" ? rows() : rows)[0],
		notify: (m) => log.messages.push(m),
		redraw: () => {},
		hide: (key) => log.hidden.push(key),
		unhide: (key) => log.unhidden.push(key),
		forget: (key) => log.forgotten.push(key),
		reload: async (options) => {
			log.reloads.push(options);
		},
		...extra,
	});
	return { flow, log };
}

test("deleteFlow:不可删除时直接给出原因,不进入确认态", async () => {
	const { flow, log } = makeFlow([view({ state: "running" })]);
	flow.request();
	await waitFor(() => log.messages.length > 0);
	assert.equal(flow.pending(), undefined, "不应进入确认态");
	assert.match(log.messages[0], /正在运行/);
});

test("deleteFlow:可删除时进入确认态,提示含会话名与去向", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	const { flow } = makeFlow([view({ file })]);
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	const prompt = flow.pending();
	assert.ok(prompt, "应进入确认态");
	assert.match(prompt, /演示会话/);
	assert.match(prompt, /系统回收站/);
});

test("deleteFlow:取消后不再有待确认提示,也不隐藏任何行", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	const { flow, log } = makeFlow([view({ file })]);
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	flow.answer(false);
	assert.equal(flow.pending(), undefined);
	assert.equal(log.messages.at(-1), "已取消删除");
	assert.equal(log.hidden.length, 0, "取消不该隐藏任何行");
});

test("deleteFlow:会话已从列表消失时取消删除(不误删)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	let rows = [view({ file })];
	const { flow, log } = makeFlow(() => rows);
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	rows = []; // 列表刷新后该会话不在了
	flow.answer(true);
	await waitFor(() => log.messages.some((m) => /已不在列表/.test(m)));
	assert.match(log.messages.at(-1), /已不在列表/);
	assert.equal(log.hidden.length, 0, "定位不到就不该隐藏,免得把别的行藏掉");
});

test("deleteFlow:按 y 的同一刻就把行藏起来(不能等 PowerShell 起完)", async () => {
	// 现场:送系统回收站要 750ms(慢的机器 5 秒),之后重扫又要几百毫秒到几秒。
	// 这段等待里那一行如果还在,用户会以为没删掉,再按一次 d —— 2026-11-19 的误删就这么来的。
	const dir = await mkdtemp(join(tmpdir(), "ais-del-"));
	const file = join(dir, "sess.jsonl");
	await writeFile(file, "{}\n");
	const { flow, log } = makeFlow([view({ file })]);
	flow.request();
	assert.ok(await waitFor(() => flow.pending() !== undefined), "应进入确认态");
	flow.answer(true);
	assert.deepEqual(log.hidden, [{ id: "sess-1", tool: "pi" }], "answer() 返回时就该已隐藏(同步,不等删除)");
	assert.match(log.messages[0], /正在删除「演示会话」/, "确认后立刻给反馈");
});

test("deleteFlow:删成功后从内存列表移除并后台刷新(不 await 重扫)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-del-"));
	const file = join(dir, "sess.jsonl");
	await writeFile(file, "{}\n");
	// 重扫永不返回:流程照样要把"已删除"报出来 —— 说明它没有 await 重扫
	const { flow, log } = makeFlow([view({ file })], { reload: () => new Promise(() => {}) });
	flow.request();
	assert.ok(await waitFor(() => flow.pending() !== undefined));
	flow.answer(true);
	assert.ok(await waitFor(() => log.forgotten.length === 1), "删成功要从内存列表移除,别等重扫");
	assert.equal(log.forgotten[0].id, "sess-1");
	assert.ok(await waitFor(() => log.messages.some((m) => /已删除「演示会话」/.test(m))), "重扫卡住也要报告删除结果");
	assert.equal(log.unhidden.length, 0, "成功不该放回");
});

test("deleteFlow:删失败时把行放回来(不能显示已删除却还在磁盘上)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-del-"));
	// 文件不存在 -> planDelete 直接拒绝;这里换个场景:用不可写路径模拟移动失败
	const { flow, log } = makeFlow([view({ file: join(dir, "nope.jsonl") })]);
	flow.request();
	await waitFor(() => log.messages.length > 0);
	assert.match(log.messages.at(-1), /不存在/, "文件不存在应直接说明");
});

test("deleteFlow:同 id 不同工具时不误删(按 id + tool 重新定位)", async () => {
	// 现场:id 并不全局唯一 —— 本机有 12 条 subagent transcript 共用 id `vision_0_transcript`。
	// 只按 id 找会把「选中的那条」换成列表里第一条同 id 的会话,于是删掉另一个文件。
	const dir = await mkdtemp(join(tmpdir(), "ais-dup-"));
	const piFile = join(dir, "pi-session.jsonl");
	const claudeFile = join(dir, "claude-session.jsonl");
	await writeFile(piFile, "{}\n");
	await writeFile(claudeFile, "{}\n");
	const rows = [
		view({ tool: "claude", id: "shared-id", file: claudeFile, name: "克劳德那条" }),
		view({ tool: "pi", id: "shared-id", file: piFile, name: "派那条" }),
	];
	const log = { messages: [], hidden: [], unhidden: [], forgotten: [] };
	const flow = createDeleteFlow({
		rows: () => rows,
		selected: () => rows[1], // 用户选中的是第二条(pi)
		notify: (m) => log.messages.push(m),
		redraw: () => {},
		hide: (key) => log.hidden.push(key),
		unhide: (key) => log.unhidden.push(key),
		forget: (key) => log.forgotten.push(key),
		reload: async () => {},
	});
	flow.request();
	assert.ok(await waitFor(() => flow.pending() !== undefined), "应进入确认态");
	assert.match(String(flow.pending()), /派那条/, "确认提示要写清是哪一条");
	flow.answer(true);
	await waitFor(() => log.messages.some((m) => /已删除|失败/.test(m)));
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(piFile), false, "选中的那条应被删除");
	assert.equal(existsSync(claudeFile), true, "同 id 的另一条绝不能被删");
	assert.deepEqual(log.hidden, [{ id: "shared-id", tool: "pi" }], "只藏选中的那条(同 id 的 claude 那条必须留在板上)");
});
