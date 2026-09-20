# ai-session-hub

**English** | [简体中文](./README.zh-CN.md)

A host-level **AI session overview** for your terminal (TUI): one keyboard-driven board listing every **running** and **historical** session of pi / Claude Code / opencode on this machine, annotated and searchable — press Enter to jump to the terminal window that owns it, open it in a **split pane**, or hand the terminal over to it.

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

## The problem

With several AI CLIs open at once, you cannot tell from the tab strip which window is doing what, which one is waiting for you, or where that session from three days ago lives. Existing tools are either *session launchers* (they spawn and own the agents, so they know everything) or *session viewers* for one vendor. Nothing answers: **"what is running on my machine right now, and how do I get back to it?"**

This tool fills that gap: it discovers sessions you already started, annotates them, and gives you one keypress to reach them.

## Features

| Feature | Notes |
|---|---|
| Session discovery | pi: `~/.pi/agent/sessions/**/*.jsonl` · Claude: `~/.claude/projects/**/*.jsonl` · opencode: `~/.local/share/opencode/opencode.db` |
| Liveness | heartbeat registry (exact) > terminal tab title match (locates the tab) > process start time vs session creation time (fallback) |
| Status annotation | parses the glyph written by pi-tab-status into `*` thinking / `>` running a tool / `\|` waiting / `?` possibly stalled / `x` error / `.` idle; sessions needing you are flagged `!` and can be filtered with `2` |
| Focus window | selects the matching Windows Terminal tab via UI Automation and brings the window forward |
| Split panes (optional) | runs the session in an embedded PTY pane next to the list, rendered by a headless terminal emulator — several sessions side by side, fully interactive (engine: [tui-panes](https://github.com/Zzz210s/tui-panes)) |
| Hand over terminal (attach) | runs `pi --session <file>` / `claude --resume <id>` in the foreground; this program **fully suspends itself** meanwhile and resumes when the session exits |
| Copy resume command | one key to put the exact command on your clipboard |
| Live refresh | 3-second poll; redraws only when the composed screen actually changes |

## Install & run

```bash
git clone https://github.com/Zzz210s/ai-session-hub.git ~/ai-session-hub
bash ~/ai-session-hub/setup.sh     # installs the optional pi heartbeat extension + creates ~/bin/ais
ais                                 # open the TUI board
```

Zero required dependencies for the core: listing, filtering, focusing and attach need only Node ≥ 24, Windows Terminal and PowerShell. The **split-pane** feature needs the optional `tui-panes` package:

```bash
npm install          # installs tui-panes (optionalDependency)
```

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` / `ctrl+p` `ctrl+n` | move the cursor (the selected row is highlighted full-width); `PageUp`/`PageDown` page, `Home`/`End` jump |
| `Enter` | smart: running session → focus its window; historical → open in a **split pane** |
| `a` | hand the terminal over to the session (attach); exits back to the board when the session ends |
| `p` | open the selected session in a split pane |
| `Tab` | cycle focus: list → pane 1 → pane 2 → list |
| `x` / `Ctrl+W` | close a pane; `Ctrl+Q` returns focus from a pane to the list |
| `f` | focus the session's terminal window |
| `c` | copy the resume command |
| `1` `2` `3` `4` | filter: running / needs attention / all / historical |
| `/` | search (name, directory, tool, session id; space-separated terms) |
| `r` | refresh now |
| `q` / `Esc` | quit |

## CLI

The same core is available without the TUI:

```bash
ais list --live          # only running sessions
ais list --json          # machine-readable (sessionFile / tab / resumeCommand)
ais doctor               # discovery diagnostics: per-tool counts, live processes, terminal tabs, heartbeats
ais focus  <query>       # focus a running session's window
```

## Architecture

```
src/
├── cli.ts            entry: TUI / list / doctor / focus
├── tui.ts            interactive loop: keys, refresh, panes, attach
├── tui-view.ts       pure rendering: state → screen lines (header, filter bar, footer)
├── tui-layout.ts     body composition: list rows + detail pane or split panes
├── tui-screen.ts     screen lifecycle: alternate screen, sequential redraw, suspend/resume, ticker
├── tui-keys.ts       key dispatch (context interface)
├── tui-context.ts    mutable UI state → key context
├── keys.ts           raw input → key names (CSI/SS3, chunk-safe)
├── text.ts           display width, padding, clamping, ANSI handling
├── model.ts          data model
├── fuzzy.ts          fuzzy match & ranking (pure)
├── format.ts         list/status formatting (pure)
├── scan/             session stores: pi.ts / claude.ts / opencode.ts / io.ts (head+tail read, streamed marker scan)
├── live/             liveness: windows.ts (processes + WT tabs via PowerShell/UIA) · heartbeat.ts · correlate.ts (pure)
├── panes.ts          adapter to the optional tui-panes engine
├── tui-attach.ts     full-terminal hand-over flow
└── actions.ts        focus / copy / attach command construction
integrations/         pi heartbeat extension · Claude Code heartbeat hook
scripts/              windows.ps1 (enumerate processes & WT tabs) · focus.ps1 (select tab + bring window forward)
```

Liveness priority: heartbeat (exact session id) → tab title (locates the tab, enables focusing) → start-time correlation (±90 s fallback).

## Development notes (learned the hard way)

1. **ConPTY rewrites absolute cursor positioning.** Writing per-line `cursorTo(row, col)` makes ConPTY re-emit the stream as text flow, garbling the screen. Redraw sequentially: `\x1b[H` + lines joined with `\r\n` + `\x1b[J`.
2. **Leave the last column empty** and never fill the terminal width exactly ("pending wrap" breaks subsequent positioning).
3. **Use ASCII in your own chrome.** Ambiguous-width glyphs (`◐ ▸ · × …`) are rendered double-width by some terminals/fonts, shifting every column; data is sanitized before display.
4. **Suspend everything before handing the terminal to a child process** (timers, `stdin`/`resize` listeners, raw mode), otherwise the TUI and the session fight over the screen.
5. **Throttle redraws** (~80 ms) — a busy pane can emit thousands of writes per second.

## Verification (development machine)

| Check | Result |
|---|---|
| Session discovery | dozens of sessions across all three store formats (pi JSONL, Claude JSONL, opencode SQLite) |
| Liveness | every running session matched to its terminal tab index and status glyph |
| Focus window | selects the tab and brings the window forward (verified repeatedly) |
| Split panes | pane renders the session's real output and accepts input |
| TUI rendering | verified with a real terminal emulator at 80/100/120/226 columns — no wrapping or drift |
| Unit tests | `node --test test/*.test.js` — all green (parsing, correlation, formatting, fuzzy match, rendering, keys, screen suspend) |
| Startup | full scan ≈ 1 second |

## Scope & limits

- **Covered**: pi (name/topic/status/focus/attach/panes), Claude Code (summary/topic/attach/panes), opencode (list/panes)
- **Not covered**: Zed, Gemini/Antigravity, cross-machine
- **Limits**: without heartbeats, tab matching relies on the session name; `psutil.open_files()` is avoided (unreliable on Windows); Claude's `~/.claude/ide/*.lock` is never read (it contains authToken)

## Roadmap

1. Zed (`db.sqlite` sidebar_threads) and Gemini/Antigravity (`brain/<id>/`) collectors
2. Session notes/tags/archiving; usage panel; hook-driven instant refresh
3. Panes: draggable ratios, scrollback inside a pane (engine: [tui-panes](https://github.com/Zzz210s/tui-panes))

## License

MIT
