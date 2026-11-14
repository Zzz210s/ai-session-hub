/**
 * TUI 动作层:选中行、光标移动、把终端交给会话(attach)、智能/聚焦/复制。
 * 单独成模块的原因:这些动作只依赖注入的几件事(行/光标/屏幕/拓展),可以在无终端环境下单测;
 * runTui 里只剩编排与渲染。
 */

import { guiLabel, type SessionView, type Tool } from "./model.ts";
import type { ActionResult } from "./actions.ts";
import { copyResumeCommand, focusSession } from "./actions.ts";
import { copySessionInfo as realCopySessionInfo, focusApp as realFocusApp } from "./gui-actions.ts";
import type { ExtensionContext, HubExtension } from "./extensions.ts";
import type { TuiScreen } from "./tui-screen.ts";
import type { ActionKind } from "./tui-keys.ts";
import { runAttach } from "./tui-attach.ts";
import { openSession } from "./open-window.ts";

export interface TuiActionDeps {
	/** 当前筛选与搜索之后的可见行 */
	rows: () => SessionView[];
	/** 当前光标位置(可能大于 rows 长度,读取时会夹紧) */
	cursorIndex: () => number;
	setCursorIndex: (index: number) => void;
	screen: TuiScreen;
	reload: () => Promise<void>;
	/** 提示行文案 */
	notify: (text: string) => void;
	redraw: () => void;
	/** 已加载的拓展(历史会话优先交给拓展打开) */
	extensions: HubExtension[];
	/** 拓展上下文(懒取:它依赖 selected,构造在本模块之后) */
	extensionContext: () => ExtensionContext;
	/** GUI 会话聚焦窗口(测试注入,默认真实现) */
	focusApp?: (tool: Tool) => Promise<ActionResult>;
	/** GUI 会话复制会话信息(测试注入,默认真实现) */
	copySessionInfo?: (view: SessionView) => Promise<ActionResult>;
	/** 打开会话(测试注入,默认真实现 openSession) */
	openSession?: (view: SessionView) => Promise<ActionResult>;
}

export interface TuiActions {
	selected: () => SessionView | undefined;
	move: (delta: number) => void;
	attach: (view: SessionView) => Promise<void>;
	attachInPlace: (view: SessionView) => Promise<void>;
	act: (kind: ActionKind) => Promise<void>;
}

/** GUI 应用的 attach 提示:没有终端可接管 */
function guiNoTerminalMessage(tool: Tool): string {
	return `${guiLabel(tool)} 是 GUI 应用:没有终端可接管,按 Enter/f 聚焦窗口`;
}

export function createTuiActions(deps: TuiActionDeps): TuiActions {
	const selected = (): SessionView | undefined => {
		const rows = deps.rows();
		return rows[Math.min(deps.cursorIndex(), Math.max(0, rows.length - 1))];
	};

	const move = (delta: number): void => {
		const rows = deps.rows();
		const current = Math.min(deps.cursorIndex(), Math.max(0, rows.length - 1));
		deps.setCursorIndex(Math.max(0, Math.min(rows.length - 1, current + delta)));
		deps.redraw();
	};

	// 默认"打开"= 开新窗口(可配置成新标签);就地接管保留给 A 键
	// 任何异常都必须落到提示行:action 是 `void ctx.act(...)` 调用的,抛出去就是
	// unhandled rejection —— Node 24 会直接终止进程,表现就是"看板闪一下就没了"
	const attach = async (view: SessionView): Promise<void> => {
		try {
			const result = await (deps.openSession ?? openSession)(view);
			deps.notify(result.detail);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notify(`打开失败: ${message}(按 c 复制命令可手动执行)`);
		}
	};
	const attachInPlace = (view: SessionView): Promise<void> =>
		runAttach(deps.screen, view, { reload: deps.reload, notify: deps.notify, redraw: deps.redraw });

	const act = async (kind: ActionKind): Promise<void> => {
		const view = selected();
		if (!view) return;
		try {
			await run(kind, view);
		} catch (error) {
			deps.notify(`操作失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		deps.redraw();
	};

	const run = async (kind: ActionKind, view: SessionView): Promise<void> => {
		// GUI 会话走窗口分支:smart/focus 都聚焦窗口,attach 没有终端可接管,copy 复制的是说明
		if (view.kind === "gui") {
			if (kind === "attach") deps.notify(guiNoTerminalMessage(view.tool));
			else if (kind === "copy") deps.notify((await (deps.copySessionInfo ?? realCopySessionInfo)(view)).detail);
			else deps.notify((await (deps.focusApp ?? realFocusApp)(view.tool)).detail);
			deps.redraw();
			return;
		}
		if (kind === "attach") {
			// 正在运行的会话:再开一个进程去 resume 同一份会话文件,pi/claude 会报占用/写坏历史,
			// 所以这里只切窗口;真要另开一份用 c 复制命令手动来
			if (view.state === "running" && view.live?.tab) {
				deps.notify(`该会话正在运行,已切到它的窗口(另开一份请按 c 复制命令): ${(await focusSession(view)).detail}`);
				return;
			}
			return attach(view);
		}
		if (kind === "attach-inplace") return attachInPlace(view);
		if (kind === "copy") {
			deps.notify((await copyResumeCommand(view)).detail);
		} else if (kind === "focus") {
			deps.notify((await focusSession(view)).detail);
		} else if (view.state === "running" && view.live?.tab) {
			deps.notify((await focusSession(view)).detail);
		} else {
			// 历史会话:交给拓展(如分屏)打开;没有拓展时提示可用 a 接管
			const opener = deps.extensions.find((extension) => extension.openSelected);
			if (opener?.openSelected) await opener.openSelected(deps.extensionContext());
			else deps.notify("该会话未运行:按 a 在新窗口继续(Shift+a 就地接管)");
		}
	};

	return { selected, move, attach, attachInPlace, act };
}
