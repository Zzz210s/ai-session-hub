# ai-session-hub

[English](./README.md) | **简体中文**

主机级 **AI 会话总览与跳转**(TUI):一个键盘驱动的全屏看板,把本机上 pi / Claude Code / opencode 的**运行中会话**与**历史会话**汇总起来,分类标注,回车即**聚焦已有终端窗口**,或**就地接管终端继续**该会话。

```
 AI 会话总览                          共 42 | 运行中 3 | 需关注 1
 1 运行中 3  2 需关注 1  3 全部 42  4 历史 39        搜索: (按 / 输入)
 > pi      auth-refactor          auth-refactor
 * pi      docs-cleanup           pi | > tool
   pi      perf-tuning            工作目录  ~/work/api
 ? claude  bug-1234              更新时间  刚刚
 ! opencode build-failure        创建时间  2026/09/18 10:22
                                  会话体积  6.1 MB
                                  进程      pid 4242
                                  终端标签  窗口 12345 - 第 3 个
                                  会话文件  ~/.pi/agent/sessions/...jsonl
 Enter 打开 | a 接管终端 | f 聚焦窗口 | c 复制 | 1-4 筛选 | / 搜索 | q 退出
```

列表里**只保留工具名与会话名**(用 `/name` 命名过的会话名以**亮黄色**突出);目录、年龄、体积、进程号、终端标签、会话文件等全部放在右侧详情面板。

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

## 启动前自更新

`ais` 打开看板**之前**,先把所有 AI CLI 及其插件的更新命令跑一遍,再用更新后的环境启动会话 —— 免得会话跑在旧 CLI / 旧插件上。

| 顺序 | 命令 | 失败处理 |
|---|---|---|
| 1 | `pi update` | **严格**:失败会出现在摘要里 |
| 2 | `pi update --extensions` | **严格** |
| 3 | `claude update` · `claude plugin update` · `opencode upgrade` · `npm i -g @openai/codex@latest` · `npm i -g @google/gemini-cli@latest` | **尽力而为**:只给装了的排步骤,失败不拦住启动 |

- **不做版本/变更检测**:每次按固定顺序跑一遍(有更新就装,没有就是空转)
- **独立程序**:只动 CLI 与它们的插件 —— 不 `git pull` 别人的仓库,也不跑别人的 `setup.sh`(由 `test/standalone.test.js` 固化)
- **跳过**:`ais --no-update` 或 `AIS_NO_UPDATE=1 ais`
- **不阻断**:任何一步失败只写进摘要,会话照常启动,例如 `[ais] 启动前自更新: 3/4 步完成,失败: 更新 pi 扩展`
- **Windows 细节**:命令统一经 **Git Bash 绝对路径**执行(裸 `bash` 可能落到 WSL),`.cmd` 交给 `cmd.exe` 转发(`execFile` 不认 `.cmd` —— 这正是早前“更新 pi 扩展”一直失败的原因)
- **退出原因可见**:TUI 退出时打印 `已退出(q)`,区分按键退出与异常退出

## 按键

| 键 | 动作 |
|---|---|
| `↑` `↓` / `j` `k` / `ctrl+p` `ctrl+n` | 移动光标(选中行整行反显);`PageUp`/`PageDown` 翻页,`Home`/`End` 首尾 |
| `Enter` | 智能:运行中→聚焦窗口;历史→就地继续 |
| `a` | 就地继续(attach):前台接管终端运行该会话 |
| `f` | 聚焦窗口(UIA 选中标签 + 置前) |
| `c` | 复制恢复命令 |
| `d` | 删除选中会话(需确认,见下) |
| `1` `2` `3` `4` | 筛选:运行中 / 需关注 / 全部 / 历史 |
| `p` / `Enter`(历史会话) | 在**分屏面板**中打开该会话(node-pty + 终端仿真) |
| `Tab` | 在列表与各面板之间切换焦点 |
| `x` / `Ctrl+W` | 关闭面板;`Ctrl+Q` 面板聚焦时回到列表 |
| `/` | 搜索(名称/目录/工具/会话 id,空格分隔多词) |
| `r` | 手动刷新 |
| `q` / `Esc` / `Ctrl+C` | 退出(退出时打印原因,如 `已退出(q)`) |

## 删除会话

选中会话按 `d`,再按 `y` 确认。三条安全规则:

1. **运行中的会话不能删**——文件正被写入;先按 `f` 聚焦窗口并退出该会话
2. **不做硬删除**:会话文件被移入 `~/.ai-session-hub/trash/`(`<时间戳>__<工具>__<原名>.jsonl`),移回原目录即可恢复
3. **同时清理残留心跳记录**,避免删掉的会话仍显示为"运行中"

命令行同样可用:

```bash
ais delete <查询>          # 只预览:打印文件与去向
ais delete <查询> --yes    # 真正移入回收目录
```

opencode 的会话存于共用 SQLite 库,**暂不支持删除**(命令会明确说明,而不是猜着删)。

## CLI(同一套核心)

```bash
ais list --live          # 只看运行中的会话
ais list --json          # 机器可读(含 sessionFile / tab / resumeCommand)
ais doctor               # 探测诊断:各工具会话数、活体进程、终端标签、心跳
ais focus  <查询>        # 聚焦运行中的会话
ais list --fast          # 快速模式:实况允许滞后 ≤60 秒,恒定 ~0.2 秒(严格路径可能等 1-16 秒探测)
ais gc [--yes]           # 清理失效心跳(默认只预览;进程已死超 24 小时或超 7 天的记录)
ais --no-update          # 跳过启动前自更新(等价 AIS_NO_UPDATE=1)
```

## 按工具着色

每个工具用各自的颜色,取色来自该 CLI 自己的调色板,列表观感与工具本身一致:

| 工具 | 取色来源 | 256 色 |
|---|---|---|
| pi | `#8abeb7`(pi 内建主题 accent) | 109 |
| Claude Code | `#d97757`(Anthropic / Claude 橙) | 209 |
| opencode | `#fab283`(opencode TUI 主题 `primary`) | 216 |
| codex | `#10a37f`(OpenAI 绿) | 35 |
| zed | `#5f87ff`(Zed 蓝) | 69 |
| gemini | `#4285f4`(Google 蓝) | 33 |
| 其他未知工具 | 中性灰 | 250 |

只给**工具名那一列**与详情面板里的工具徽标着色;状态字形仍用它自己的状态色(绿/黄/红/暗),选中行保持整行反显——行内不插 RESET,因此光标高亮不会被打断。

```bash
NO_COLOR=1 ais        # 或 AIS_COLOR=0 ais       —— 完全关掉着色
```

`ais doctor` 会打印当前配色。

被 `/name` 命名过的会话名用**亮黄色**(256 色 11)显示,便于与自动生成标题区分。

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

内置默认加载 `tui-panes`(装了就用,没装则核心功能完全不受影响)。拓展清单可用环境变量 `AIS_EXTENSIONS=a,b` 或 `~/.ai-session-hub/extensions.json` 覆盖。**只想跑核心(不要分屏)**就把清单显式置空:

```json
{ "extensions": [] }
```

(或 `AIS_EXTENSIONS=none`)。显式的空清单表示"不要任何拓展",不会被当成"用默认清单"。

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

**没装拓展就完全不出现拓展相关字样**:未加载任何拓展时,界面里不会出现"拓展/分屏/面板"等字样,底部只列核心键位;此时对历史会话按 Enter 只会提示"该会话未运行:按 a 接管终端继续"。拓展自己的键位提示(如 `Enter 分屏打开`)只在真正加载了拓展后才显示。

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

## 性能

结果都缓存在 `~/.ai-session-hub/cache/`,按文件指纹失效,因此重复运行很便宜:

| 操作 | 冷启动 | 热启动 |
|---|---|---|
| `ais list`(71 个会话 + 活体探测) | ~4.6 s | **~0.25 s** |
| TUI 首帧(TUI 路径:先用上次快照) | **~0.3 s** | **~0 s** |
| `ais list` 严格路径(等真探测) | 1.2-16 s | 同左(波动来自 PowerShell) |
| `ais list --fast`(实况 ≤60 秒旧) | ~0.2 s | ~0.2 s |

慢在哪、改了什么:

1. **探测 Windows Terminal 标签时用 `TrueCondition` 枚举了所有顶层窗口** —— 每个子元素的属性读取都是跨进程调用,探测因此要 ~15 s。改为按窗口类做服务端过滤:**~1.3 s**。
2. **`Get-CimInstance Win32_Process` 没做服务端过滤**,一次传 ~350 行;改为按进程名过滤。
3. **完全没有缓存** —— TUI 每 3 秒重跑一次完整探测。现在:活体探测缓存 8 秒(`AIS_LIVE_TTL_MS`,TUI 用 15 秒),单文件解析结果按 size+mtime 缓存(`AIS_SCAN_TTL_MS`,默认 24 小时)。
4. **TUI 要先加载完才画第一帧** —— 现在立即出界面,并且**先用上次快照渲染、后台刷新**(见下)。

### 先渲染旧的、后台刷新(stale-while-revalidate)

PowerShell 探测在本机实测 **1.2-2.3 秒**、冷启动 6-16 秒;会话扫描 0.3-1.2 秒。界面为它们空等,就是"启动之后一段没意义的空白"。

TUI 的加载(首帧与每 3 秒的刷新)因此都带 `staleLive` + `staleSessions`:

- 缓存新鲜 → 直接用,零成本
- 缓存过期但在 10 分钟内(`AIS_LIVE_STALE_MS`) → **立刻拿它渲染**,同时在后台重新探测/扫描;下一次刷新(≤3 秒后)就是新的
- 缓存太旧或不存在 → 才同步取

CLI(`ais list` / `ais doctor`)不带这两个开关:**每次都真探真扫**,不会拿旧数据糊弄你。

### 缓存分层与命中率(实测)

板面每 3 秒刷一次,而"重活"有两件:会话扫描(0.3-2 秒)与 PowerShell 探测(1.2-2 秒)。缓存按**数据变化的快慢**分两层:

| 数据 | 变化频率 | 策略 | 实测 |
|---|---|---|---|
| 会话列表(扫描结果) | 低(只有出现/消失/新增内容时才变) | 结构指纹(会话目录 mtime)+ 最长 60 秒;不变就不重扫 | 每 20 次刷新仅 1 次重扫 |
| 心跳 + 探测快照(运行中/工作/等待) | 高 | 每次现读(~25ms),探测另有 15 秒快照缓存 | 板面状态不滞后 |
| 单个会话文件的解析 | 活跃会话在增长 | 按 size+mtime 缓存;**增量**:只看上次之后新增的字节 | 冷 10-24 秒 → **~2 秒**,热 0.2 秒 |

早先的实现把整份视图按固定 TTL(5 秒)缓存,实测每 3 秒刷一次时**命中率只有 55%** —— 面板没变也每 5 秒空扫一次。现在:

```
视图缓存命中率   55% → 95%(20 次刷新里 19 次纯命中)
单次加载         30-70ms(首帧冷启动 0.3 秒内)
会话扫描         冷(缓存过期/首次)1-2 秒,热 0.2 秒
```

会话名的查找也从"全文流式扫描"改成"新增字节 → 尾部 8MB → 头部 256KB"的三层策略:一个 197MB 的会话文件原来要扫 10 秒以上,现在 20 毫秒。

### 心跳注册表 GC

崩溃/被杀的会话不会自己删心跳文件(正常退出会删),几周就能积到几百上千个,而每次读注册表都要 stat+read 全部文件。清理规则:记录损坏或时间戳不可解析、进程已死且超 24 小时、超 7 天(不论 pid —— 本机实测存在 **pid 复用**,不能只看 pid)。

- **自动**:pi / claude 的心跳集成在会话启动时各扫一遍(`integrations/pi-heartbeat.ts`、`integrations/claude-heartbeat.mjs`)
- **手动**:`ais gc`(预览) / `ais gc --yes`(清理);`ais doctor` 会显示"N 条有效 / 目录共 M 个文件"
- 本机实测:459 → 34 个文件后,读注册表 **143 ms → 22 ms**

### PowerShell 引擎

`windows.ps1` / `focus.ps1` / `recycle.ps1` 在 PowerShell 7(pwsh)下都能跑(已逐个验证),但**默认仍用系统自带的 powershell.exe** —— 5 轮交替实测 `windows.ps1`:

| 引擎 | 最小 | 平均 |
|---|---|---|
| `powershell.exe` | **1254 ms** | **1363 ms** |
| `pwsh` 7 | 1431 ms | 1714 ms |

想切:`AIS_PWSH=C:/path/to/pwsh.exe ais`(pwsh 坏掉时自动回退到 powershell.exe,不会让探测一直失败)。

### 启动前自更新的进度

每一步都打印开始与结果(含耗时,失败带原因),更新期间不再是无输出的干等。
**不同工具的步骤并行跑**(同一个工具的两步仍保持先后顺序,npm 全局安装也都归一组),实测 4 步从串行 11.7 秒降到 ~11 秒(pi 组仍是长边);
当慢的是 claude / npm 那几组时收益更大:

```
[ais] 执行 4 项更新…
[ais] 更新 pi 本体…
[ais] 更新 pi 本体 完成(3.2s)
[ais] 更新 pi 扩展 失败(4.1s): 需要先 ...
[ais] 启动前自更新: 3/4 步完成,失败: 更新 pi 扩展
```

缓存开关:

```bash
ais list --no-cache        # 本次绕过缓存
AIS_CACHE=0 ais            # 完全关闭缓存
AIS_LIVE_TTL_MS=3000       # 活体探测有效期(0 = 每次都探)
AIS_LIVE_STALE_MS=60000    # 允许先用多久以内的旧探测快照渲染(仅 TUI)
AIS_PWSH=C:/path/pwsh.exe  # 换 PowerShell 引擎(默认 powershell.exe;0=强制自带)
AIS_SCAN_TTL_MS=0          # 关闭单文件扫描缓存
rm -rf ~/.ai-session-hub/cache   # 清空
```

