import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePreflightShell, startPreflight } from "../src/preflight-run.ts";
import { readPreflightState, stateFilePath, writePreflightState } from "../src/preflight-ttl.ts";

/** 没有 Git Bash 就排不出步骤(startPreflight 会直接返回 undefined),这类用例跳过 */
const noShell = !resolvePreflightShell();

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "ais-start-"));
	const saved = { home: process.env.AIS_HOME, ttl: process.env.AIS_UPDATE_TTL, off: process.env.AIS_NO_UPDATE };
	process.env.AIS_HOME = home;
	delete process.env.AIS_UPDATE_TTL;
	delete process.env.AIS_NO_UPDATE;
	return {
		home,
		restore() {
			for (const [key, value] of [["AIS_HOME", saved.home], ["AIS_UPDATE_TTL", saved.ttl], ["AIS_NO_UPDATE", saved.off]]) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		},
	};
}

/** 假 runner:DSH 探测走它,一律回"没装",不碰网络 */
const offlineRunner = async () => ({ ok: false, out: "" });
const okPreflight = async (options) => ({ steps: options.steps.map((s) => ({ label: s.label, ok: true })), summary: `${options.steps.length} 步全部完成` });
const badPreflight = async (options) => ({
	steps: options.steps.map((s, i) => ({ label: s.label, ok: i !== 0, detail: i === 0 ? "boom" : undefined })),
	summary: `${options.steps.length - 1}/${options.steps.length} 步完成,失败: ${options.steps[0].label}`,
});

test("startPreflight:全部成功才写时间戳", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const line = await startPreflight({ runner: offlineRunner, runPreflight: okPreflight });
		assert.match(String(line), /全部成功/, "摘要应报告全部成功");
		const state = readPreflightState(stateFilePath());
		assert.equal(typeof state.lastSuccessAt, "number", "成功必须写时间戳,否则 TTL 永远不生效");
	} finally {
		box.restore();
	}
});

test("startPreflight:任一步失败不写时间戳(下次启动立刻重试)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const line = await startPreflight({ runner: offlineRunner, runPreflight: badPreflight });
		assert.doesNotMatch(String(line), /全部成功/);
		assert.equal(readPreflightState(stateFilePath()).lastSuccessAt, undefined, "失败绝不能写时间戳 —— 否则会被 TTL 挡住,坏状态一直留着");
		assert.equal(existsSync(stateFilePath()), false);
	} finally {
		box.restore();
	}
});

test("startPreflight:TTL 内直接跳过,不执行任何命令", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		writePreflightState(stateFilePath(), Date.now() - 60_000);
		let ran = 0;
		const line = await startPreflight({
			runner: async () => {
				ran += 1;
				return { ok: false, out: "" };
			},
			runPreflight: async () => {
				ran += 1;
				return { steps: [], summary: "should not run" };
			},
		});
		assert.match(String(line), /前检查过,跳过/);
		assert.equal(ran, 0, "跳过时不该执行任何命令(连 DSH 探测都不该跑)");
	} finally {
		box.restore();
	}
});

test("startPreflight:AIS_UPDATE_TTL=0 时 TTL 内也照跑", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		process.env.AIS_UPDATE_TTL = "0";
		writePreflightState(stateFilePath(), Date.now() - 60_000);
		let ran = 0;
		const line = await startPreflight({
			runner: offlineRunner,
			runPreflight: async (options) => {
				ran += 1;
				return okPreflight(options);
			},
		});
		assert.equal(ran, 1, "AIS_UPDATE_TTL=0 必须每次都跑");
		assert.match(String(line), /全部成功/);
	} finally {
		box.restore();
	}
});

test("startPreflight:AIS_NO_UPDATE=1 静默跳过(连跳过行都不打印)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		process.env.AIS_NO_UPDATE = "1";
		let ran = 0;
		const line = await startPreflight({
			runner: async () => {
				ran += 1;
				return { ok: false, out: "" };
			},
			runPreflight: async () => {
				ran += 1;
				return { steps: [], summary: "" };
			},
		});
		assert.equal(line, undefined);
		assert.equal(ran, 0);
	} finally {
		box.restore();
	}
});

test("startPreflight:成功后的第二次启动被 TTL 挡住", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		await startPreflight({ runner: offlineRunner, runPreflight: okPreflight });
		const second = await startPreflight({ runner: offlineRunner, runPreflight: badPreflight });
		assert.match(String(second), /前检查过,跳过/, "第二次应被 TTL 挡住,而不是又跑一遍(还失败)");
	} finally {
		box.restore();
	}
});
