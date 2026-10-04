import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionSummary, parseUninstallVersions, planDshCliStep } from "../src/apps.ts";

test("parseUninstallVersions:从卸载项里认出 Zed 与 DeepSeek Harness", () => {
	const versions = parseUninstallVersions([
		{ DisplayName: "Zed", DisplayVersion: "1.18.0" },
		{ DisplayName: "DeepSeek Harness 0.2.0-rc.2", DisplayVersion: "0.2.0-rc.2" },
		{ DisplayName: "别的软件", DisplayVersion: "9.9" },
	]);
	assert.deepEqual(versions, { zed: "1.18.0", dsh: "0.2.0-rc.2" });
});

test("appVersionSummary:缺版本也要给出可读的一行", () => {
	assert.equal(appVersionSummary({ zed: "1.18.0", dsh: "0.2.0-rc.2" }), "Zed 1.18.0 / DeepSeek Harness 0.2.0-rc.2(GUI 应用自更新,ais 不代管)");
	assert.match(appVersionSummary({}), /未检测到/);
});

test("planDshCliStep:只有装了全局 CLI 才排更新步骤", () => {
	assert.equal(planDshCliStep({ npmAvailable: true, hasGlobalCli: false }), undefined);
	const step = planDshCliStep({ npmAvailable: true, hasGlobalCli: true });
	assert.equal(step.label, "更新 DSH CLI");
	assert.equal(step.group, "npm");
	assert.deepEqual(step.args.slice(0, 3), ["i", "-g", "@deepseek-ai/dsh@latest"]);
	assert.equal(planDshCliStep({ npmAvailable: false, hasGlobalCli: true }), undefined);
});
