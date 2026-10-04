import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionSummary, parseUninstallVersions, planDshCliStep, readAppVersions } from "../src/apps.ts";

const SHELL = "C:/Program Files/Git/bin/bash.exe";

test("parseUninstallVersions:从卸载项里认出 Zed 与 DeepSeek Harness", () => {
	const versions = parseUninstallVersions([
		{ DisplayName: "Zed", DisplayVersion: "1.18.0" },
		{ DisplayName: "DeepSeek Harness 0.2.0-rc.2", DisplayVersion: "0.2.0-rc.2" },
		{ DisplayName: "别的软件", DisplayVersion: "9.9" },
	]);
	assert.deepEqual(versions, { zed: "1.18.0", dsh: "0.2.0-rc.2" });
});

test("parseUninstallVersions:PowerShell 只回单个对象(非数组)时也能解析", () => {
	assert.deepEqual(parseUninstallVersions({ DisplayName: "Zed", DisplayVersion: "1.0.0" }), { zed: "1.0.0" });
});

test("appVersionSummary:缺版本也要给出可读的一行", () => {
	assert.equal(appVersionSummary({ zed: "1.18.0", dsh: "0.2.0-rc.2" }), "Zed 1.18.0 / DeepSeek Harness 0.2.0-rc.2(GUI 应用自更新,ais 不代管)");
	assert.match(appVersionSummary({}), /未检测到/);
});

test("appVersionSummary:带上 DSH CLI 状态(未安装跳过 / 已更新)", () => {
	assert.match(appVersionSummary({ zed: "1.18.0", dsh: "0.2.0-rc.2" }, "not-installed"), /DSH 全局 CLI:未安装,跳过\)$/);
	assert.match(appVersionSummary({ zed: "1.18.0" }, "updated"), /DSH 全局 CLI:已更新\)$/);
});

test("planDshCliStep:只有装了全局 CLI 才排更新步骤,且经 shell 执行", () => {
	assert.equal(planDshCliStep({ npmAvailable: true, hasGlobalCli: false, shell: SHELL }), undefined);
	assert.equal(planDshCliStep({ npmAvailable: true, hasGlobalCli: true }), undefined, "没有 shell 时不排步骤");
	const step = planDshCliStep({ npmAvailable: true, hasGlobalCli: true, shell: SHELL });
	assert.equal(step.label, "更新 DSH CLI");
	assert.equal(step.group, "npm");
	assert.notEqual(step.command, "npm", "必须经 shell:Windows 上裸 npm 会 ENOENT");
	assert.equal(step.command, SHELL);
	assert.equal(step.args[0], "-lc");
	assert.match(step.args[1], /^npm i -g @deepseek-ai\/dsh@latest /);
	assert.match(step.args[1], /\|\| true$/, "尽力而为:失败不拦启动");
	assert.equal(step.timeoutMs, 900_000, "对齐同类 npm 步骤");
	assert.equal(planDshCliStep({ npmAvailable: false, hasGlobalCli: true, shell: SHELL }), undefined);
});

test("readAppVersions:注入假 runner 也能解析出版本", { skip: process.platform !== "win32" }, async () => {
	let calls = 0;
	const runner = async () => {
		calls += 1;
		return { ok: true, out: JSON.stringify([{ DisplayName: "DeepSeek Harness", DisplayVersion: "0.3.0" }]) };
	};
	assert.deepEqual(await readAppVersions({ shell: SHELL, runner }), { dsh: "0.3.0" });
	assert.equal(calls, 1, "必须经注入的 runner(测试不真的跑 powershell)");
});
