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
	/** 同组内顺序执行;不同组之间并行(各家 CLI 互不干扰,没理由排队等) */
	group?: string;
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
	/** 每一步完成后回调(标签、是否成功、耗时毫秒、失败时的输出尾部) */
	onStepDone?: (step: { label: string; ok: boolean; ms: number; detail?: string }) => void;
}

/**
 * 执行步骤:同组按声明顺序跑,不同组并行。
 *
 * 为什么分组并行:实测本机 4 步串行要 11.7 秒(pi 本体 1.8s + pi 扩展 4.6s + claude 4.4s + claude 插件 0.9s),
 * 而这两家的更新毫无依赖关系 —— 并行后取最长组 ≈ 6 秒。同一个工具的两步仍保持先后顺序(避免锁/缓存冲突),
 * npm 全局安装也都归到"npm"一组,不会同时跑两个 npm。
 */
export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
	const run = options.runner ?? execRunner;
	const steps = options.steps;
	const results: PreflightResult["steps"] = new Array(steps.length);

	const runOne = async (index: number): Promise<void> => {
		const step = steps[index]!;
		options.onProgress?.(`${step.label}…`);
		const startedAt = performance.now();
		const { ok, out } = await run(step.command, step.args, step.timeoutMs);
		const ms = Math.round(performance.now() - startedAt);
		const detail = ok ? undefined : out.split("\n").slice(-2).join(" ").slice(0, 160);
		results[index] = { label: step.label, ok, detail };
		options.onStepDone?.({ label: step.label, ok, ms, detail });
	};

	const groups = new Map<string, number[]>();
	steps.forEach((step, index) => {
		const key = step.group ?? "";
		const list = groups.get(key);
		if (list) list.push(index);
		else groups.set(key, [index]);
	});
	const runGroup = async (indexes: number[]): Promise<void> => {
		for (const index of indexes) await runOne(index);
	};
	// 单组(或没标组)时就是纯顺序执行 —— 与旧行为一致
	await Promise.all([...groups.values()].map(runGroup));

	const failed = results.filter((result) => !result.ok);
	const summary =
		failed.length === 0 ? `${results.length} 步全部完成` : `${results.length - failed.length}/${results.length} 步完成,失败: ${failed.map((f) => f.label).join("、")}`;
	return { steps: results, summary };
}
