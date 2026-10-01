import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planSteps, preflight, shouldRun } from "../src/preflight.ts";

const HOUR = 3600_000;

test("shouldRun:开关 / 强制 / 首次 / TTL 内外", () => {
	assert.equal(shouldRun(undefined, 0, { disabled: true }).run, false, "禁用优先");
	assert.equal(shouldRun({ at: 0, summary: "x" }, HOUR, { force: true }).run, true, "强制");
	assert.equal(shouldRun(undefined, 0).run, true, "首次运行");
	assert.equal(shouldRun({ at: 0, summary: "x" }, 3 * HOUR).run, false, "TTL 内跳过");
	assert.equal(shouldRun({ at: 0, summary: "x" }, 7 * HOUR).run, true, "超过 TTL");
});

test("planSteps:不含不存在的仓库,必含 pi 本体与扩展两步", () => {
	const home = mkdtempSync(join(tmpdir(), "ais-pf-"));
	const steps = planSteps({ home, piBin: "pi", bash: "bash" });
	assert.equal(steps.filter((s) => s.label.startsWith("拉新")).length, 0, "临时 home 下没有配置仓库");
	assert.ok(steps.some((s) => s.label === "更新 pi 本体"));
	assert.ok(steps.some((s) => s.label === "更新扩展"));
	assert.ok(!steps.some((s) => s.label === "重新部署配置"), "无 config-ai 时不部署");
});

test("preflight:执行并写缓存,TTL 内第二次不再执行", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ais-pf2-"));
	const stateFile = join(dir, "preflight.json");
	const calls = [];
	const runner = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`.trim());
		return { ok: true, out: "" };
	};
	const steps = [{ label: "假步骤", command: "echo", args: ["hi"], timeoutMs: 1000 }];
	const first = await preflight({ stateFile, runner, steps, now: 1000 });
	assert.equal(first.ran, true);
	assert.equal(first.steps[0].ok, true);
	assert.match(first.summary, /1 步/);
	assert.equal(calls.length, 1, "应只执行一次");
	const second = await preflight({ stateFile, runner, steps, now: 1000 + HOUR });
	assert.equal(second.ran, false, "TTL 内应跳过");
	assert.equal(calls.length, 1, "跳过时不执行任何命令");
	const third = await preflight({ stateFile, runner, steps, now: 1000 + 7 * HOUR });
	assert.equal(third.ran, true, "超过 TTL 重新执行");
});

test("preflight:某步失败不抛异常,摘要体现失败项", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ais-pf3-"));
	const runner = async () => ({ ok: false, out: "boom\n网络不可用" });
	const result = await preflight({
		stateFile: join(dir, "pf.json"),
		runner,
		steps: [{ label: "拉新 x", command: "git", args: [], timeoutMs: 1000 }],
		now: 5000,
	});
	assert.equal(result.ran, true);
	assert.equal(result.steps[0].ok, false);
	assert.match(result.summary, /失败/);
	assert.match(result.steps[0].detail, /网络不可用/);
});
