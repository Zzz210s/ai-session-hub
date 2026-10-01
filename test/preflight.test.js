/**
 * 启动前自更新执行器单测:只验证"顺序执行 + 汇总"(步骤由调用方给)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { preflight } from "../src/preflight.ts";

const step = (label) => ({ label, command: "echo", args: [label], timeoutMs: 1000 });

test("preflight:按顺序执行,全成功时摘要为 N 步全部完成", async () => {
	const calls = [];
	const runner = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		return { ok: true, out: "" };
	};
	const result = await preflight({ steps: [step("a"), step("b")], runner });
	assert.deepEqual(calls, ["echo a", "echo b"], "顺序与参数应原样传递");
	assert.equal(result.summary, "2 步全部完成");
	assert.deepEqual(result.steps.map((s) => s.ok), [true, true]);
});

test("preflight:某步失败不抛异常,摘要列出失败项并保留错误尾部", async () => {
	const runner = async (command, args) => (args[0] === "bad" ? { ok: false, out: "line1\nboom" } : { ok: true, out: "" });
	const result = await preflight({ steps: [step("ok1"), step("bad"), step("ok2")], runner });
	assert.equal(result.summary, "2/3 步完成,失败: bad");
	assert.equal(result.steps[1].ok, false);
	assert.equal(result.steps[1].detail, "line1 boom");
	assert.equal(result.steps[0].detail, undefined, "成功步不带 detail");
});

test("preflight:onProgress 逐步回调(用于打印 [ais] 行)", async () => {
	const seen = [];
	await preflight({ steps: [step("a"), step("b")], runner: async () => ({ ok: true, out: "" }), onProgress: (message) => seen.push(message) });
	assert.deepEqual(seen, ["a…", "b…"]);
});

test("preflight:空步骤表不崩,摘要为 0 步", async () => {
	const result = await preflight({ steps: [], runner: async () => ({ ok: true, out: "" }) });
	assert.equal(result.summary, "0 步全部完成");
});

test("preflight:不同组并行、同组保序", async () => {
	const started = new Map();
	const finished = [];
	const runner = async (command, args) => {
		const label = args[0];
		started.set(label, performance.now());
		await new Promise((resolve) => setTimeout(resolve, 120));
		finished.push(label);
		return { ok: true, out: "" };
	};
	const steps = [
		{ label: "A1", command: "x", args: ["A1"], timeoutMs: 1000, group: "A" },
		{ label: "B1", command: "x", args: ["B1"], timeoutMs: 1000, group: "B" },
		{ label: "A2", command: "x", args: ["A2"], timeoutMs: 1000, group: "A" },
	];
	const at = performance.now();
	const result = await preflight({ steps, runner });
	const elapsed = performance.now() - at;
	assert.ok(elapsed < 300, `两组并行应约 240ms,实际 ${Math.round(elapsed)}ms(串行会是 360ms+)`);
	assert.ok(finished.indexOf("A1") < finished.indexOf("A2"), "同组必须保序");
	assert.deepEqual(result.steps.map((s) => s.label), ["A1", "B1", "A2"], "结果按声明顺序返回");
});
