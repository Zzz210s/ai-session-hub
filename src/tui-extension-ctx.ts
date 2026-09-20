import type { SessionView } from "./model.ts";
import { resumeCommand } from "./actions.ts";
import type { ExtensionContext, ExtensionSession } from "./extensions.ts";
import { layoutMetricsFor } from "./tui-view.ts";

/** 拓展上下文依赖(由 TUI 注入,避免拓展层直接依赖 TUI 内部状态) */
export interface ExtensionCtxDeps {
	selected(): SessionView | undefined;
	/** 终端原始尺寸(不含拓展视图判断,避免递归) */
	size(): { width: number; height: number };
	notify(message: string): void;
	redraw(): void;
	schedule(): void;
}

/** 构造传给拓展的上下文:会话信息(含恢复命令)+ 可用尺寸 + 提示与重绘 */
export function createExtensionContext(deps: ExtensionCtxDeps): ExtensionContext {
	return {
		selected: (): ExtensionSession | undefined => {
			const view = deps.selected();
			if (!view) return undefined;
			return {
				id: view.id,
				title: view.name?.trim() || view.topic?.trim() || view.id.slice(0, 8),
				tool: view.tool,
				cwd: view.cwd,
				command: resumeCommand(view),
				state: view.state,
			};
		},
		metrics: () => {
			// 拓展关心的是"它接管主体区时"能用多大空间
			const { width, height } = deps.size();
			const { leftWidth, rightWidth, bodyHeight } = layoutMetricsFor(width, height, true);
			return { leftWidth, rightWidth, bodyHeight };
		},
		notify: deps.notify,
		redraw: deps.redraw,
		schedule: deps.schedule,
	};
}
