/**
 * 整屏接管会话(attach):交出终端 → 前台运行 → 收回终端并恢复看板
 * 关键:交出前必须挂起屏幕(停刷新、摘监听、退出 raw),否则与子进程抢屏。
 */

import type { SessionView } from "./model.ts";
import { attachSession, resumeCommand } from "./actions.ts";
import { cliAvailable, missingCliMessage } from "./resume.ts";
import type { TuiScreen } from "./tui-screen.ts";

export async function runAttach(
	screen: TuiScreen,
	view: SessionView,
	hooks: { reload: () => Promise<void>; notify: (message: string) => void; redraw: () => void },
): Promise<void> {
	// 就地接管走的是同一份命令:可执行文件不在就只提示,别把终端交出去(交出去回来才知道是 127)
	if (!cliAvailable(view.tool)) {
		hooks.notify(missingCliMessage(view.tool));
		hooks.redraw();
		return;
	}
	screen.handOff(`[ai-session-hub] 正在接管终端: ${resumeCommand(view)}`);
	const code = await attachSession(view);
	hooks.notify(`会话已退出(exit ${code})`);
	await hooks.reload();
	screen.resume();
	hooks.redraw();
}
