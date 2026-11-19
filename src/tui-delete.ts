/**
 * TUI 的删除流程:确认提示 → 执行 → 刷新
 * 单独成模块的原因:破坏性操作需要清晰的确认语义与"按 id 重新定位"防错。
 */

import type { SessionView } from "./model.ts";
import { deleteSession, planDelete } from "./delete.ts";
import { fullTitle } from "./format.ts";

export interface DeleteFlowDeps {
	/** 当前列表(用于按 id 重新定位会话) */
	rows(): SessionView[];
	/** 当前选中会话 */
	selected(): SessionView | undefined;
	notify(message: string): void;
	redraw(): void;
	/**
	 * 重新读列表。
	 * staleSessions: false = 绕过板面缓存、真扫一遍 —— 删完必须这么读,
	 * 否则缓存里那条还在,界面上"删掉的会话"依旧显示,看起来就像没删成功。
	 */
	reload(options?: { staleSessions?: boolean }): Promise<void>;
}

export interface DeleteFlow {
	/** 待确认时的提示文案;无待确认返回 undefined */
	pending(): string | undefined;
	/** 请求删除选中会话(不可删除时直接给出原因) */
	request(): void;
	/** 确认/取消 */
	answer(accepted: boolean): void;
}

export function createDeleteFlow(deps: DeleteFlowDeps): DeleteFlow {
	/**
	 * 存 id + 工具(不是对象):列表刷新后仍能定位,又不会认错。
	 * 只按 id 找会出事 —— id 并不全局唯一:本机有 12 条 subagent transcript 共用
	 * id `vision_0_transcript`,只按 id 匹配会删掉列表里第一条同 id 的**另一个文件**(误删)。
	 */
	let pending: { id: string; tool: SessionView["tool"] } | null = null;

	/** 按 id + 工具定位(同 id 不同工具是两条不同的会话) */
	const locate = (key: { id: string; tool: SessionView["tool"] }): SessionView | undefined =>
		deps.rows().find((row) => row.id === key.id && row.tool === key.tool);

	const prompt = (key: { id: string; tool: SessionView["tool"] }): string => {
		const view = locate(key);
		const label = view ? fullTitle(view) : `${key.tool} ${key.id.slice(0, 8)}`;
		return `删除「${label}」?会放入系统回收站(可在${process.platform === "win32" ? "资源管理器" : "文件管理器"}还原)`;
	};

	return {
		pending: () => (pending ? prompt(pending) : undefined),
		request() {
			const view = deps.selected();
			if (!view) return;
			void planDelete(view).then((plan) => {
				if (!plan.supported) {
					deps.notify(plan.reason ?? "不可删除");
					deps.redraw();
					return;
				}
				pending = { id: view.id, tool: view.tool };
				deps.redraw();
			});
		},
		answer(accepted) {
			const key = pending;
			pending = null;
			if (!accepted || !key) {
				deps.notify("已取消删除");
				deps.redraw();
				return;
			}
			const view = locate(key);
			if (!view) {
				deps.notify("会话已不在列表中,删除取消");
				deps.redraw();
				return;
			}
			// 先给反馈:送系统回收站要起一次 PowerShell(慢的那台机器上 5 秒起),
			// 这几秒里界面如果什么都不显示,用户会以为"按 y 没反应"
			deps.notify(`正在删除「${fullTitle(view)}」…`);
			deps.redraw();
			void deleteSession(view)
				.then(async (result) => {
					deps.notify(result.detail);
					// 必须真扫:板面缓存里那条还在,读缓存会让"已删除的会话"继续显示
					await deps.reload({ staleSessions: false });
					deps.redraw();
				})
				// 删除链路任何一步抛异常都不能变成 unhandled rejection(那会直接终止 TUI)
				.catch((error: unknown) => {
					deps.notify(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
					deps.redraw();
				});
		},
	};
}
