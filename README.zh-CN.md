# ai-session-hub

[English](./README.md) | **简体中文**

主机级 **AI 会话总览与跳转**(TUI):一个键盘驱动的全屏看板,把本机上 pi / Claude Code / opencode 的**运行中会话**与**历史会话**汇总起来,分类标注,回车即**聚焦已有终端窗口**,或**就地接管终端继续**该会话。

```
 AI 会话总览                              共 42 | 运行中 3 | 需关注 1
 1 运行中 3  2 需关注 1  3 全部 42  4 历史 39            搜索: (按 / 输入)
 > pi      auth-refactor   work/api     - 刚刚 - t2      auth-refactor
 * pi      docs-cleanup    work/docs    - 2 分钟前 - t1   pi | > 执行工具
   pi      perf-tuning     work/engine  - 1 小时前        工作目录  ~/work/api
 ? claude  bug-1234        work/web     - 3 小时前        更新时间  刚刚
 ! opencode schema-migrate work/db      - 5 小时前        会话体积  6.1 MB
                                                        终端标签  窗口 12345 - 第 3 个
                                                        会话文件  ~/.pi/agent/sessions/...jsonl
 Enter 分屏打开 | a 接管终端 | f 聚焦窗口 | c 复制 | Tab 切换面板 | 1-4 筛选 | / 搜索 | q 退出
```

## 解决什么问题

同时开多个 AI CLI 时:哪个窗口在跑什么、哪个在等确认、三天前那个会话在哪——只能靠记忆。现有开源工具要么是**自己托管**会话的编排器(agent-deck / ccmanager / claude-squad / izll ASMGR),要么是 GUI(SessionHub),都假设会话由它们启动。本工具补的是这一层:**发现你自己手动开的会话 + 键盘一览 + 回车跳过去或就地继续**。

## 能力

| 能力 | 说明 |
|---|---|
| 会话发现 | pi:`~/.pi/agent/sessions/**/*.jsonl` · Claude:`~/.claude/projects/**/*.jsonl` · opencode:`~/.local/share/opencode/opencode.db` |
| 活性判定 | 心跳注册表(精确)> 终端标签标题匹配(定位标签)> 进程启动时间与会话创建时间接近(兜底) |
| 状态标注 | 解析 pi-tab-status 的标签字形:`◐`思考中 / `▸`执行工具 / `_`等待输入 / `?`疑似卡住 / `×`出错 / `·`空闲;需关注的会话标 `!` 并可用 `2` 单独筛选 |
| 聚焦窗口 | 经 UI Automation 选中对应的 Windows Terminal 标签并把窗口置前(实测可用) |
| 就地继续(attach) | 让出终端,在前台运行 `pi --session <文件>` / `claude --resume <id>`;期间本程序**完全挂起**(停刷新、摘监听、退出 raw 模式),退出会话后自动回到看板 |
| 复制命令 | 一键把恢复命令放进剪贴板 |
| 实时刷新 | 3 秒轮询,内容变化才重绘(无闪烁) |
| 拓展 | 核心可被拓展增强(**同页分屏**由拓展 [tui-panes](https://github.com/Zzz210s/tui-panes) 提供);核心不引用任何具体拓展,缺失时功能不受影响 |
| 终端兼容 | 字形与分隔符全部 ASCII(宽度不确定字符会因字体按双宽渲染而错位);整屏顺序重绘(ConPTY 会重写逐行绝对定位);末列留白避免折行挂起 |

## 安装与运行

```bash
bash setup.sh        # 安装 pi 心跳扩展(可选,提升活性判定精度)+ 生成 ~/bin/ais
ais                  # 打开 TUI 看板
```

**零依赖**:核心与 TUI 只用 Node 内建能力(无 npm 依赖,不需要 `npm install`)。要求 Node ≥ 24(用到原生 TypeScript 执行与 `node:sqlite`)、Windows Terminal、PowerShell(系统自带)。

## 按键

| 键 | 动作 |
|---|---|
| `↑` `↓` / `j` `k` / `ctrl+p` `ctrl+n` | 移动光标(选中行整行反显);`PageUp`/`PageDown` 翻页,`Home`/`End` 首尾 |
| `Enter` | 智能:运行中→聚焦窗口;历史→就地继续 |
| `a` | 就地继续(attach):前台接管终端运行该会话 |
| `f` | 聚焦窗口(UIA 选中标签 + 置前) |
| `c` | 复制恢复命令 |
| `1` `2` `3` `4` | 筛选:运行中 / 需关注 / 全部 / 历史 |
| `p` / `Enter`(历史会话) | 在**分屏面板**中打开该会话(node-pty + 终端仿真) |
| `Tab` | 在列表与各面板之间切换焦点 |
| `x` / `Ctrl+W` | 关闭面板;`Ctrl+Q` 面板聚焦时回到列表 |
| `/` | 搜索(名称/目录/工具/会话 id,空格分隔多词) |
| `r` | 手动刷新 |
| `q` / `Esc` | 退出 |

## CLI(同一套核心)

```bash
ais list --live          # 只看运行中的会话
ais list --json          # 机器可读(含 sessionFile / tab / resumeCommand)
ais doctor               # 探测诊断:各工具会话数、活体进程、终端标签、心跳
ais focus  <查询>        # 聚焦运行中的会话
```

## Shell 适配(Git Bash / PowerShell)

工具本身是 Node 程序,可在任意终端里跑;需要"执行命令"的两处——**接管终端(attach)** 与 **分屏面板**——会用**你本机的 shell** 承载命令:

| 环境 | 选择 | 启动参数 |
|---|---|---|
| shell 探测顺序 | `AIS_SHELL` 指定 > Git Bash > PowerShell 7(`pwsh`) > Windows PowerShell 5.1 > cmd | 用 `ais doctor` 可看当前探测结果 |
| Git Bash | `bash.exe` | `-lc "<command>; exec bash"`(命令结束后保持可交互) |
| PowerShell | `powershell.exe` / `pwsh.exe` | `-NoLogo -NoProfile -NoExit -Command "<command>"` |
| cmd | `cmd.exe` | `/d /s /c "<command>"` |

覆盖方式(临时或永久):

```bash
export AIS_SHELL="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
```

**在 PowerShell 里使用**:`setup.sh` 会安装三种启动器到 `~/bin`——`ais`(bash)、`ais.cmd`(cmd)、`ais.ps1`(PowerShell):

```powershell
& $HOMEinis.ps1            # 打开 TUI
& $HOMEinis.ps1 list --live
```

**聚焦已有窗口的两种情形**:
- **Windows Terminal**(主流):枚举标签页标题并选中对应标签(状态字形 + 会话名来自本工具生态)
- **传统控制台窗口**(conhost / 独立 PowerShell 窗口):用 `AttachConsole(pid) + GetConsoleWindow()` 定位该会话所在的窗口并置前(自动排除 ConPTY 的 `PseudoConsoleWindow` 占位句柄)

## 拓展(核心与拓展的边界)

**本仓库是核心**:负责会话发现、活性判定、标注、聚焦/接管/复制命令,以及 TUI 骨架。**同页分屏等能力由拓展提供**——核心不引用任何具体拓展。

内置默认加载 `tui-panes`(装了就用,没装则核心功能完全不受影响)。拓展清单可用环境变量 `AIS_EXTENSIONS=a,b` 或 `~/.ai-session-hub/extensions.json`(`{"extensions":["tui-panes"]}`)覆盖。

拓展是一个普通模块(通常是仓库/包),导出 `createHubExtension()`,返回:

| 钩子 | 作用 |
|---|---|
| `name` | 拓展名(必填) |
| `hints?: string[]` | 底部提示里展示自己的键位(仅当它接管视图时显示) |
| `openSelected?(ctx)` | 核心的 Enter 智能动作会调用(如"在分屏里打开该会话") |
| `bodyView?(ctx): string[] \| undefined` | 接管主体区渲染(返回已组合好的行);不接管则显示核心的详情视图 |
| `handleKey?(key, ctx): boolean` | 自己的按键(返回 true 表示已消费) |
| `handleRawInput?(text, ctx): boolean` | 原始输入(面板聚焦时按键直达会话) |
| `onResize?(ctx)` / `dispose?()` | 尺寸变化 / 退出清理 |

`ctx` 提供:`selected(): { id, title, tool, cwd, command, state }`(含**恢复命令**,拓展无需了解核心细节)、`metrics()`(它接管视图时可用尺寸)、`notify/redraw/schedule`。

现有拓展:[tui-panes](https://github.com/Zzz210s/tui-panes)(同页分屏)。

## 架构

```
src/
├── cli.ts              命令入口(TUI / list / doctor / focus)
├── tui.ts              交互循环:按键、3 秒刷新、拓展加载、attach(挂起/恢复终端)
├── tui-view.ts         纯渲染:状态 → 屏幕行(CJK 宽度、视口、配色)
├── tui-layout.ts       主体区:列表行 + 详情或(拓展接管的)自定义内容
├── tui-screen.ts       屏幕生命周期:备用屏 · 顺序重绘 · 挂起/恢复 · 刷新计时器
├── tui-keys.ts         按键分发 · tui-context.ts 状态→上下文 · keys.ts 原始输入解析
├── extensions.ts       拓展接口与加载器(默认加载 tui-panes)
├── tui-extension-ctx.ts 传给拓展的上下文(会话信息含恢复命令 + 尺寸 + 提示)
├── model.ts            数据模型
├── fuzzy.ts            模糊匹配与排序(纯)
├── format.ts           列表与状态格式化(纯)
├── text.ts             显示宽度/补齐/截断/ANSI 处理(纯)
├── scan/               会话采集:pi / claude / opencode / io(头尾读 + 流式标记扫描)
├── live/               活体:windows(进程 + WT 标签,经 PowerShell/UIA)· heartbeat · correlate(纯)
├── tui-attach.ts       整屏接管流程(交出终端 → 前台运行 → 收回)
└── actions.ts          聚焦 / 复制命令 / attach 命令构造
integrations/           pi 心跳扩展 · Claude Code 心跳钩子
scripts/                windows.ps1(枚举进程与标签)· focus.ps1(选中标签 + 置前)
```

**活性优先级**:心跳(sessionId 精确)→ 标签标题(可定位标签,支持聚焦)→ 启动时间相关性(±90 秒兜底)。

## 验证(开发机实测)

| 检查项 | 结果 |
|---|---|
| 会话发现 | 数十个会话,覆盖 pi / Claude / opencode 三种存储格式 |
| 活性判定 | 运行中的会话全部匹配到终端标签序号与状态字形 |
| 聚焦窗口 | 经 UI Automation 选中标签并置前,多次实测成功 |
| 分屏面板(**由拓展提供**) | 同页并排运行多个会话,每格是真实 PTY,输出经终端仿真渲染;见拓展 [tui-panes](https://github.com/Zzz210s/tui-panes) |
| TUI 渲染 | 用真实终端模拟器逐尺寸核对(80/100/120/226 列),无折行错位 |
| 单测 | `node --test test/*.test.js` 全部通过(采集解析 / 合并 / 格式化 / 模糊匹配 / 渲染 / 按键 / 屏幕挂起) |
| 启动耗时 | 全量扫描约 1 秒 |

## 覆盖与边界

- **已覆盖**:pi(名称/主题/状态/精确聚焦/attach)、Claude Code(摘要/话题/attach `--resume`)、opencode(会话列表 + attach)
- **未覆盖**:Zed、Gemini/Antigravity、跨机器
- **限制**:无心跳时标签匹配依赖会话名;不用 `psutil.open_files()` 判定归属(Windows 上不可靠);不读取 Claude 的 `~/.claude/ide/*.lock`(含 authToken)

## 路线图

1. Zed(`db.sqlite` sidebar_threads)与 Gemini/Antigravity(`brain/<id>/`)采集
2. 会话备注/标签/归档;额度面板;hook 驱动的秒级刷新
3. 分屏:可拖拽调整面板比例、面板内滚动回看(引擎见 [tui-panes](https://github.com/Zzz210s/tui-panes))

## 开发

同时改本仓库与 [tui-panes](https://github.com/Zzz210s/tui-panes) 时,把本地检出的拓展链进来,改完立刻生效(不写 `package.json` 与 lock 文件):

```bash
npm run dev:link -- ../tui-panes     # 指向你本地的 tui-panes 目录(改它的源码后需先 npm run build)
npm test                             # 核心逻辑单测
```

## License

MIT
