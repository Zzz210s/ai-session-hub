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

test("deleteFlow:不可删除时直接给出原因,不进入确认态", async () => {
	const messages = [];
	const flow = createDeleteFlow({
		rows: () => [view({ state: "running" })],
		selected: () => view({ state: "running" }),
		notify: (m) => messages.push(m),
		redraw: () => {},
		reload: async () => {},
	});
	flow.request();
	await waitFor(() => messages.length > 0);
	assert.equal(flow.pending(), undefined, "不应进入确认态");
	assert.match(messages[0], /正在运行/);
});

test("deleteFlow:可删除时进入确认态,提示含会话名与去向", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	const flow = createDeleteFlow({
		rows: () => [view({ file })],
		selected: () => view({ file }),
		notify: () => {},
		redraw: () => {},
		reload: async () => {},
	});
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	const prompt = flow.pending();
	assert.ok(prompt, "应进入确认态");
	assert.match(prompt, /演示会话/);
	assert.match(prompt, /系统回收站/);
});

test("deleteFlow:取消后不再有待确认提示", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	const messages = [];
	const flow = createDeleteFlow({
		rows: () => [view({ file })],
		selected: () => view({ file }),
		notify: (m) => messages.push(m),
		redraw: () => {},
		reload: async () => {},
	});
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	flow.answer(false);
	assert.equal(flow.pending(), undefined);
	assert.equal(messages.at(-1), "已取消删除");
});

test("deleteFlow:会话已从列表消失时取消删除(不误删)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-flow-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, "{}\n");
	const messages = [];
	let rows = [view({ file })];
	const flow = createDeleteFlow({
		rows: () => rows,
		selected: () => rows[0],
		notify: (m) => messages.push(m),
		redraw: () => {},
		reload: async () => {},
	});
	flow.request();
	await waitFor(() => flow.pending() !== undefined);
	rows = []; // 列表刷新后该会话不在了
	flow.answer(true);
	await waitFor(() => messages.some((m) => /已不在列表/.test(m)));
	assert.match(messages.at(-1), /已不在列表/);
});

test("deleteFlow:确认后先给「正在删除」反馈,删完强制重扫(绕开板面缓存)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ais-del-"));
	const file = join(dir, "sess.jsonl");
	await writeFile(file, "{}\n");
	const messages = [];
	const reloads = [];
	const flow = createDeleteFlow({
		rows: () => [view({ file })],
		selected: () => view({ file }),
		notify: (m) => messages.push(m),
		redraw: () => {},
		reload: async (options) => {
			reloads.push(options);
		},
	});
	flow.request();
	assert.ok(await waitFor(() => flow.pending()), "应进入确认态");
	flow.answer(true);
	assert.match(messages[0], /正在删除「演示会话」/, "确认后立刻给反馈,不能静默等几秒");
	assert.ok(await waitFor(() => reloads.length > 0), "删除完成后应重读列表");
	assert.deepEqual(reloads[0], { staleSessions: false }, "必须真扫,否则缓存里那条还在");
});

test("deleteFlow:同 id 不同工具时不误删(按 id + tool 重新定位)", async () => {
	// 现场:id 并不全局唯一 —— 本机有 12 条 subagent transcript 共用 id `vision_0_transcript`。
	// 只按 id 找会把「选中的那条」换成列表里第一条同 id 的会话,于是删掉另一个文件。
	const dir = await mkdtemp(join(tmpdir(), "ais-dup-"));
	const piFile = join(dir, "pi-session.jsonl");
	const claudeFile = join(dir, "claude-session.jsonl");
	await writeFile(piFile, "{}\n");
	await writeFile(claudeFile, "{}\n");
	const messages = [];
	const rows = [
		view({ tool: "claude", id: "shared-id", file: claudeFile, name: "克劳德那条" }),
		view({ tool: "pi", id: "shared-id", file: piFile, name: "派那条" }),
	];
	const flow = createDeleteFlow({
		rows: () => rows,
		selected: () => rows[1], // 用户选中的是第二条(pi)
		notify: (m) => messages.push(m),
		redraw: () => {},
		reload: async () => {},
	});
	flow.request();
	assert.ok(await waitFor(() => flow.pending() !== undefined), "应进入确认态");
	assert.match(String(flow.pending()), /派那条/, "确认提示要写清是哪一条");
	flow.answer(true);
	await waitFor(() => messages.some((m) => /已删除|失败/.test(m)));
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(piFile), false, "选中的那条应被删除");
	assert.equal(existsSync(claudeFile), true, "同 id 的另一条绝不能被删");
});
