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
}

export interface TuiActions {
	selected: () => SessionView | undefined;
	move: (delta: number) => void;
	attach: (view: SessionView) => Promise<void>;
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

	const attach = (view: SessionView): Promise<void> =>
		runAttach(deps.screen, view, { reload: deps.reload, notify: deps.notify, redraw: deps.redraw });

	const act = async (kind: ActionKind): Promise<void> => {
		const view = selected();
		if (!view) return;
		// GUI 会话走窗口分支:smart/focus 都聚焦窗口,attach 没有终端可接管,copy 复制的是说明
		if (view.kind === "gui") {
			if (kind === "attach") deps.notify(guiNoTerminalMessage(view.tool));
			else if (kind === "copy") deps.notify((await (deps.copySessionInfo ?? realCopySessionInfo)(view)).detail);
			else deps.notify((await (deps.focusApp ?? realFocusApp)(view.tool)).detail);
			deps.redraw();
			return;
		}
		if (kind === "attach") return attach(view);
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
			else deps.notify("该会话未运行:按 a 接管终端继续");
		}
		deps.redraw();
	};

	return { selected, move, attach, act };
}
