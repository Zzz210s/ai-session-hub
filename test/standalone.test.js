import assert from "node:assert/strict";
import { test } from "node:test";
import { planUpdateSteps } from "../src/preflight-run.ts";

test("独立性:更新步骤不含别人仓库的 git pull,也不跑别人的 setup.sh", () => {
	const steps = planUpdateSteps({ piBin: "C:/x/pi.CMD", gitBash: "C:/Program Files/Git/bin/bash.exe" });
	const labels = steps.map((step) => step.label);
	assert.ok(!labels.some((label) => label.startsWith("拉新 ")), "不应有配置仓库拉取: " + labels.join(","));
	assert.ok(!labels.some((label) => label.includes("重新部署")), "不应跑别人的 setup.sh: " + labels.join(","));
	assert.ok(!steps.some((step) => step.command === "git"), "不应调用 git");
	assert.ok(labels.includes("更新 pi 本体"), "应更新 pi 本体");
	assert.ok(labels.includes("更新 pi 扩展"), "应更新 pi 扩展");
});
