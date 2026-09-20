/**
 * TUI 屏幕控制:备用屏进出、整屏重绘、挂起/恢复、刷新计时器
 *
 * 单独成模块的原因:attach 会话时必须彻底让出终端(停计时器、摘掉 resize/stdin
 * 监听、退出 raw 模式),否则本程序会与被接管的会话抢屏——这段逻辑需要集中管理。
 */

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";

export interface TuiScreenOptions {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
	/** 原始输入回调(挂起期间会被摘掉) */
	onData: (chunk: Buffer) => void;
	/** 终端尺寸变化回调(挂起期间会被摘掉) */
	onResize: () => void;
}

export interface TuiScreen {
	readonly suspended: boolean;
	/** 进入备用屏并隐藏光标 */
	enter(): void;
	/** 退出备用屏、显示光标并打印结束信息 */
	leave(message: string): void;
	/** 整屏重绘(回 home → 逐行 \r\n → 清尾);内容未变且非强制时跳过 */
	draw(lines: string[], signature: string, force?: boolean): void;
	/** 交出终端给会话:退出备用屏、打印提示并挂起 */
	handOff(message: string): void;
	/** 让出终端:停计时器、摘监听、退出 raw 模式 */
	suspend(): void;
	/** 收回终端:重进备用屏、恢复监听与计时器 */
	resume(): void;
	/** 启动/停止刷新计时器 */
	startTicker(callback: () => void, intervalMs: number): void;
	stopTicker(): void;
}

export function createTuiScreen(options: TuiScreenOptions): TuiScreen {
	const { stdin, stdout, onData, onResize } = options;
	let suspended = false;
	let lastSignature = "";
	let timer: ReturnType<typeof setInterval> | null = null;

	const stopTicker = (): void => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	const detachListeners = (): void => {
		stdout.off("resize", onResize);
		stdin.off("data", onData);
		stdin.setRawMode?.(false);
		stdin.pause();
	};

	const attachListeners = (): void => {
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.on("data", onData);
		stdout.on("resize", onResize);
	};

	const suspend = (): void => {
		if (suspended) return;
		suspended = true;
		stopTicker();
		detachListeners();
	};

	const resume = (): void => {
		if (!suspended) return;
		suspended = false;
		lastSignature = "";
		stdout.write(`${ALT_ON}${CURSOR_HIDE}`);
		attachListeners();
	};

	return {
		get suspended() {
			return suspended;
		},
		enter() {
			stdout.write(`${ALT_ON}${CURSOR_HIDE}`);
			attachListeners();
		},
		leave(message) {
			stopTicker();
			detachListeners();
			stdout.write(`${ALT_OFF}${CURSOR_SHOW}\u001b[2m[ai-session-hub] ${message}\u001b[0m\r\n`);
		},
		handOff(message) {
			// 交出终端给会话:退出备用屏、恢复光标、打印提示,然后彻底挂起
			stdout.write(`${ALT_OFF}${CURSOR_SHOW}\u001b[2m${message}\u001b[0m\r\n\r\n`);
			suspend();
		},
		draw(lines, signature, force = false) {
			if (suspended) return; // 终端已被会话接管,写入会抢屏
			if (!force && signature === lastSignature) return;
			lastSignature = signature;
			// 顺序输出而非逐行绝对定位:ConPTY 会把绝对光标移动重写成文本流导致错乱
			stdout.write(`\u001b[H${lines.join("\r\n")}\u001b[J`);
		},
		suspend,
		resume,
		startTicker(callback, intervalMs) {
			if (timer) return;
			timer = setInterval(callback, intervalMs);
		},
		stopTicker,
	};
}
