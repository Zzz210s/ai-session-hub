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

## 架构

```
src/
├── cli.ts          命令入口(TUI / list / doctor / focus)
├── tui.ts          交互循环:按键、3 秒刷新、attach(挂起/恢复终端)
├── tui-view.ts     纯渲染层:状态 → 屏幕行(CJK 宽度、视口、配色),可单测
├── model.ts        数据模型
├── fuzzy.ts        模糊匹配与排序(纯)
├── format.ts       列表与状态格式化(纯)
├── scan/           会话采集:pi.ts / claude.ts / opencode.ts / io.ts(头尾读 + 流式标记扫描)
├── live/           活体:windows.ts(进程 + WT 标签,经 PowerShell/UIA)· heartbeat.ts · correlate.ts(纯)
├── pty/            分屏面板(可选依赖 node-pty + @xterm/headless):pane.ts · manager.ts · render.ts · integration.ts
└── actions.ts      聚焦 / 复制命令 / attach 命令构造
integrations/       pi 心跳扩展 · Claude Code 心跳钩子
scripts/            windows.ps1(枚举进程与标签)· focus.ps1(选中标签 + 置前)
```

**活性优先级**:心跳(sessionId 精确)→ 标签标题(可定位标签,支持聚焦)→ 启动时间相关性(±90 秒兜底)。

## 验证(开发机实测)

| 检查项 | 结果 |
|---|---|
| 会话发现 | 数十个会话,覆盖 pi / Claude / opencode 三种存储格式 |
| 活性判定 | 运行中的会话全部匹配到终端标签序号与状态字形 |
| 聚焦窗口 | 经 UI Automation 选中标签并置前,多次实测成功 |
| 分屏面板(可选) | node-pty + @xterm/headless:面板内渲染会话真实输出,可交互;见 [tui-panes](https://github.com/Zzz210s/tui-panes) |
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

## License

MIT
