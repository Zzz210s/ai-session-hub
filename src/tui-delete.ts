/**
 * TUI 的删除流程:确认提示 → 立刻把行藏起来 → 后台送回收站 → 静默刷新
 *
 * 为什么要"先藏":送系统回收站要起一次 PowerShell(实测 750ms,慢的机器 5 秒起),
 * 之后再重扫会话列表又要几百毫秒到几秒。这段等待里如果那一行还留在屏幕上,
 * 用户看到的就是"说删了但还在",于是不知道到底删没删 —— 只能再按一次 d,
 * 然后第二次删掉别的文件(2026-11-19 的误删事故就是这么来的)。
 *
 * 因此:确认后**同步**把行藏起来(0ms 反馈),真正删完再确认结果:
 *   - 成功 → 从内存列表里彻底移除 + 后台刷新(不 await,不阻塞界面)
 *   - 失败 → 把行放回来 + 说明原因(不会出现"显示删了其实没删")
 */

import type { SessionView } from "./model.ts";
import { deleteSession, planDelete } from "./delete.ts";
import { fullTitle } from "./format.ts";
import { pruneBoardCache } from "./views-cache.ts";

/** 定位用的键:id 不全局唯一,必须带工具(见 tui-delete 的误删说明) */
export interface DeleteKey {
	id: string;
	tool: SessionView["tool"];
}

export interface DeleteFlowDeps {
	/** 当前列表(用于按 id 重新定位会话) */
	rows(): SessionView[];
	/** 当前选中会话 */
	selected(): SessionView | undefined;
	notify(message: string): void;
	redraw(): void;
	/** 立刻隐藏一行(删除一开始就调用,让用户马上看到它消失) */
	hide(key: DeleteKey): void;
	/** 放回隐藏的行(删除失败时) */
	unhide(key: DeleteKey): void;
	/** 真删掉后从内存列表移除(不必等重扫) */
	forget(key: DeleteKey): void;
	/**
	 * 重新读列表。删除后**不要 await**:全量重扫要几百毫秒到几秒,
	 * 等它只会让界面卡在"已删除"和旧列表之间。会话目录 mtime 变了,
	 * 下一次 3 秒节拍刷新自然会重扫。
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

const sameKey = (view: SessionView, key: DeleteKey): boolean => view.id === key.id && view.tool === key.tool;

/**
 * 删除成功:从内存列表彻底去掉,并抹掉磁盘板面快照里的同一条 ——
 * 不抹快照的话,删完立刻退出 ais,下次启动(6 小时内)首帧又会把它摆出来。
 */
export function dropRow(rows: SessionView[], key: DeleteKey): SessionView[] {
	void pruneBoardCache([key]).catch(() => undefined);
	return rows.filter((row) => !sameKey(row, key));
}

export function createDeleteFlow(deps: DeleteFlowDeps): DeleteFlow {
	/**
	 * 存 id + 工具(不是对象):列表刷新后仍能定位,又不会认错。
	 * 只按 id 找会出事 —— id 并不全局唯一:本机有 12 条 subagent transcript 共用
	 * id `vision_0_transcript`,只按 id 匹配会删掉列表里第一条同 id 的**另一个文件**(误删)。
	 */
	let pending: DeleteKey | null = null;

	/** 按 id + 工具定位(同 id 不同工具是两条不同的会话) */
	const locate = (key: DeleteKey): SessionView | undefined => deps.rows().find((row) => sameKey(row, key));

	const prompt = (key: DeleteKey): string => {
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
			// 同步藏起来:按 y 的这一刻界面就该有变化,而不是等 PowerShell 起完
			deps.hide(key);
			deps.notify(`正在删除「${fullTitle(view)}」…`);
			deps.redraw();
			void deleteSession(view)
				.then((result) => {
					if (result.ok) {
						// 真删掉了:从内存列表移除,再让后台刷新去对齐磁盘(不 await)
						deps.forget(key);
						deps.notify(result.detail);
					} else {
						deps.unhide(key);
						deps.notify(result.detail);
					}
					deps.redraw();
					void deps.reload().catch(() => undefined);
				})
				// 删除链路任何一步抛异常都不能变成 unhandled rejection(那会直接终止 TUI)
				.catch((error: unknown) => {
					deps.unhide(key);
					deps.notify(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
					deps.redraw();
				});
		},
	};
}
