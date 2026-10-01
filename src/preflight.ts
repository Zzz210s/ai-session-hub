/**
 * 启动前自更新的执行器:按顺序跑步骤,汇总结果;任何一步失败都不抛异常。
 *
 * 这里只有"执行 + 汇总"两件事:步骤由调用方给(preflight-run.ts 负责组装),
 * 升级策略也在调用方 —— 于是本模块可以在测试里用假 runner 完全离线验证。
 */

import { execFile } from "node:child_process";

export interface Step {
	label: string;
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface PreflightResult {
	/** 实际执行的步骤(调用方给什么就是什么) */
	steps: { label: string; ok: boolean; detail?: string }[];
	/** 人类可读摘要:`N 步全部完成` / `M/N 步完成,失败: a、b` */
	summary: string;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string }>;

/** 默认执行器:带超时,静默失败(返回 ok=false 而不抛) */
export const execRunner: Runner = (command, args, timeoutMs) =>
	new Promise((resolve) => {
		try {
			execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				resolve({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
			});
		} catch (error) {
			resolve({ ok: false, out: String(error) });
		}
	});

export interface PreflightOptions {
	steps: Step[];
	runner?: Runner;
	onProgress?: (message: string) => void;
}

/** 顺序执行步骤;失败只记录,不影响后续步骤 */
export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
	const run = options.runner ?? execRunner;
	const results: PreflightResult["steps"] = [];
	for (const step of options.steps) {
		options.onProgress?.(`${step.label}…`);
		const { ok, out } = await run(step.command, step.args, step.timeoutMs);
		results.push({ label: step.label, ok, detail: ok ? undefined : out.split("\n").slice(-2).join(" ").slice(0, 160) });
	}
	const failed = results.filter((result) => !result.ok);
	const summary =
		failed.length === 0 ? `${results.length} 步全部完成` : `${results.length - failed.length}/${results.length} 步完成,失败: ${failed.map((f) => f.label).join("、")}`;
	return { steps: results, summary };
}
