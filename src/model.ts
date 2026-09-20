/**
 * 数据模型:会话记录、活体信息、合并后的视图
 */

export type Tool = "pi" | "claude" | "opencode";

/** 从会话存储解析出来的一条会话记录 */
export interface SessionRecord {
	tool: Tool;
	/** 工具内部的会话 id */
	id: string;
	/** 会话存储文件路径 */
	file: string;
	/** 会话所属工作目录(存储文件里记录的 cwd) */
	cwd: string;
	/** 用户显式命名(pi 的 /name、opencode 的 title) */
	name?: string;
	/**
	 * 是否"被用户命名过"(工具提供了真正的命名字段)。
	 * pi 的 /name 属于此类;Claude 只有自动摘要、opencode 的 title 多为首条消息
	 * 自动生成,均不算命名 —— 列表里用亮黄色突出真正命名的会话。
	 */
	named?: boolean;
	/** 展示用标题:名称优先,否则首个用户消息摘要 */
	topic: string;
	/** 首条用户消息原文(用于模糊搜索) */
	firstMessage: string;
	createdAt: Date;
	updatedAt: Date;
	/** 消息条数(需要全量扫描才能精确,部分工具不提供) */
	messageCount?: number;
	/** 会话存储文件大小(字节,廉价可得,用于辨识体量) */
	sizeBytes?: number;
	/** 父会话(分叉/fork 来源) */
	parentId?: string;
}

/** 正在运行的 AI CLI 进程 */
export interface LiveProcess {
	pid: number;
	tool: Tool;
	startedAt: Date;
	/** 命令行(截断) */
	args: string;
	/** 内部子进程(如 pi 的 --mode json 子代理),不算独立会话 */
	internal?: boolean;
}

/** 终端里的一个标签页(Windows Terminal 经 UI Automation 枚举) */
export interface TerminalTab {
	/** 宿主窗口句柄 */
	hwnd: string;
	/** 宿主窗口所属进程(WindowsTerminal.exe) */
	windowPid: number;
	/** 窗口标题(WT 里等于当前选中标签的标题) */
	windowTitle: string;
	/** 标签在窗口内的序号(0 起) */
	index: number;
	title: string;
	selected: boolean;
}

/**
 * 控制台窗口(非 Windows Terminal 场景:conhost / Windows PowerShell 控制台等)
 * 通过 AttachConsole(pid) + GetConsoleWindow() 定位,可按 pid 精确对应到会话进程。
 */
export interface ConsoleWindow {
	hwnd: string;
	pid: number;
	title: string;
}

/** 心跳注册表里的一条记录(由各 CLI 的集成写出,最可靠的活性信号) */
export interface Heartbeat {
	tool: Tool;
	pid?: number;
	sessionId: string;
	sessionFile?: string;
	cwd?: string;
	name?: string;
	/** working | tool | waiting | idle | error */
	status?: string;
	/** 是否在等用户输入 */
	attention?: boolean;
	updatedAt: string;
}

/** 合并后的会话视图(扫描结果 + 活性 + 终端位置) */
export interface SessionView extends SessionRecord {
	live?: {
		pid?: number;
		heartbeat?: Heartbeat;
		tab?: TerminalTab;
		console?: ConsoleWindow;
	};
	/** 展示用状态:running / idle / stored */
	state: "running" | "idle" | "stored";
	/** 状态细节(心跳状态或标签字形) */
	status?: string;
	attention: boolean;
}
