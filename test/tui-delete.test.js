import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDeleteFlow } from "../src/tui-delete.ts";

/** 等条件成立(避免并行跑测试时固定 sleep 不够) */
async function waitFor(condition, timeoutMs = 2000) {
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
