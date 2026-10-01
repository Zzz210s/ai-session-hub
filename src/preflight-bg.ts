/**
 * 后台预检入口:由 preflight-run.ts 以 detached 方式拉起,独立完成自更新后退出。
 * 单独成文件,避免在 cli.ts 里再加分支(也避免后台进程加载整个 TUI)。
 */
import { preflight } from "./preflight.ts";

const result = await preflight({ force: true });
if (result.ran) {
	process.stdout.write("[brief] preflight: " + result.summary);
}
