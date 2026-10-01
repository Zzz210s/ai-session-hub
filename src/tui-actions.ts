/**
 * TUI 动作层:选中行、光标移动、把终端交给会话(attach)、智能/聚焦/复制。
 * 单独成模块的原因:这些动作只依赖注入的几件事(行/光标/屏幕/拓展),可以在无终端环境下单测;
 * runTui 里只剩编排与渲染。
 */

import type { SessionView } from "./model.ts";
import { copyResumeCommand, focusSession } from "./actions.ts";
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
}

export interface TuiActions {
	selected: () => SessionView | undefined;
	move: (delta: number) => void;
	attach: (view: SessionView) => Promise<void>;
	act: (kind: ActionKind) => Promise<void>;
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
