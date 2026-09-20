# ai-session-hub

**English** | [简体中文](./README.zh-CN.md)

A host-level **AI session overview** for your terminal (TUI): one keyboard-driven board listing every **running** and **historical** session of pi / Claude Code / opencode on this machine, annotated and searchable — press Enter to jump to the terminal window that owns it, open it in a **split pane**, or hand the terminal over to it.

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

The list keeps only **tool + session name** (names you set with `/name` are highlighted in bright yellow); everything else — directory, age, size, pid, terminal tab, session file — lives in the right-hand detail pane.

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
| Split panes (**provided by an extension**) | several sessions running side by side in the same page: each pane is a real PTY whose output is emulated and composed into this program (engine: the [tui-panes](https://github.com/Zzz210s/tui-panes) extension) |
| Hand over terminal (attach) | runs `pi --session <file>` / `claude --resume <id>` in the foreground; this program **fully suspends itself** meanwhile and resumes when the session exits |
| Copy resume command | one key to put the exact command on your clipboard |
| Live refresh | 3-second poll; redraws only when the composed screen actually changes |
| Extensions | the core can be extended (split panes come from the [tui-panes](https://github.com/Zzz210s/tui-panes) extension); the core references no concrete extension and works fine without any |

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
| `Enter` | smart: a running session → focus its window; a historical one → open in a **split pane** (this second behaviour exists only when the split-pane extension is installed) |
| `a` | hand the terminal over to the session (attach); exits back to the board when the session ends |
| `p` | open the selected session in a split pane |
| `Tab` | cycle focus: list → pane 1 → pane 2 → list |
| `x` / `Ctrl+W` | close a pane; `Ctrl+Q` returns focus from a pane to the list |
| `f` | focus the session's terminal window |
| `c` | copy the resume command |
| `d` | delete the selected session (asks for confirmation; see below) |
| `1` `2` `3` `4` | filter: running / needs attention / all / historical |
| `/` | search (name, directory, tool, session id; space-separated terms) |
| `r` | refresh now |
| `q` / `Esc` | quit |

## Deleting a session

Press `d` on a session and confirm with `y`. Three safety rules apply:

1. **Running sessions cannot be deleted** — the file is being written to; focus the window (`f`) and exit the session first.
2. **Nothing is hard-deleted**: the session file is moved to `~/.ai-session-hub/trash/` (`<timestamp>__<tool>__<name>.jsonl`), so it can be restored by moving it back.
3. **Stale heartbeat entries are cleaned up** at the same time, so a deleted session does not linger as "running".

From the CLI:

```bash
ais delete <query>          # preview only: prints the file and destination
ais delete <query> --yes    # actually move it to the trash
```

opencode sessions live in a shared SQLite database and are **not** deletable yet (the command says so instead of guessing).

## CLI

The same core is available without the TUI:

```bash
ais list --live          # only running sessions
ais list --json          # machine-readable (sessionFile / tab / resumeCommand)
ais doctor               # discovery diagnostics: per-tool counts, live processes, terminal tabs, heartbeats
ais focus  <query>       # focus a running session's window
```

## Per-tool colors

Each tool gets its own color, taken from that CLI's own palette so the list looks at home next to the tools themselves:

| Tool | Source color | 256-color |
|---|---|---|
| pi | `#8abeb7` (pi's built-in theme accent) | 109 |
| Claude Code | `#d97757` (Anthropic / Claude orange) | 209 |
| opencode | `#fab283` (opencode TUI theme `primary`) | 216 |
| codex | `#10a37f` (OpenAI green) | 35 |
| zed | `#5f87ff` (Zed blue) | 69 |
| gemini | `#4285f4` (Google blue) | 33 |
| anything else | neutral gray | 250 |

Only the tool column (and the tool badge in the detail pane) is tinted; the status glyph keeps its own state color (green / yellow / red / dim), and the selected row stays a plain inverse highlight so the cursor is never broken up by embedded resets.

```bash
NO_COLOR=1 ais        # or: AIS_COLOR=0 ais      — disable all coloring
```

`ais doctor` prints the palette in use.

Named sessions (set with `/name`) render their name in **bright yellow** (256-color 11), so sessions you care about stand out from auto-generated titles.

## Shell support (Git Bash / PowerShell)

The tool itself is a Node program and runs anywhere; the two places that *execute commands* — **attach** and **split panes** — carry them with **your machine's shell**:

| | |
|---|---|
| Detection order | `AIS_SHELL` override → Git Bash → PowerShell 7 (`pwsh`) → Windows PowerShell 5.1 → cmd. `ais doctor` prints what was detected |
| Git Bash | `bash.exe -lc "<command>; exec bash"` (stays interactive afterwards) |
| PowerShell | `powershell.exe` / `pwsh.exe` `-NoLogo -NoProfile -NoExit -Command "<command>"` |
| cmd | `cmd.exe /d /s /c "<command>"` |

Override it, temporarily or permanently:

```bash
export AIS_SHELL="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
```

**Using it from PowerShell**: `setup.sh` installs three launchers into `~/bin` — `ais` (bash), `ais.cmd` (cmd), `ais.ps1` (PowerShell):

```powershell
& $HOMEinis.ps1            # open the TUI
& $HOMEinis.ps1 list --live
```

**Focusing an existing window** — two cases:
- **Windows Terminal** (the common one): its tabs are enumerated and the matching tab is selected (tab titles carry the status glyph + session name written by this tool's ecosystem)
- **Legacy console windows** (conhost / a standalone PowerShell window): located via `AttachConsole(pid) + GetConsoleWindow()` and brought to front (ConPTY `PseudoConsoleWindow` placeholders are filtered out)

## Extensions (core vs. extension)

**This repository is the core**: session discovery, liveness, annotation, focus/attach/copy, and the TUI shell. **Same-page split panes are provided by an extension** — the core references no concrete extension.

`tui-panes` is loaded by default (used if installed; the core is unaffected when it is missing). Override the list with `AIS_EXTENSIONS=a,b`, or `~/.ai-session-hub/extensions.json`. To run the **core alone** (no split panes), make the list explicitly empty:

```json
{ "extensions": [] }
```

(or `AIS_EXTENSIONS=none`). An explicitly empty list means "no extensions", not "use the defaults".

An extension is a plain module (usually a package/repo) exporting `createHubExtension()`:

| Hook | Purpose |
|---|---|
| `name` | extension name (required) |
| `hints?: string[]` | key hints shown while its view is active |
| `openSelected?(ctx)` | called by the core's smart Enter action ("open this session in a split pane") |
| `bodyView?(ctx): string[] \| undefined` | take over the body area (return composed lines); `undefined` keeps the core detail view |
| `handleKey?(key, ctx): boolean` | its own keys (return `true` when consumed) |
| `handleRawInput?(text, ctx): boolean` | raw input (so keys reach a focused pane) |
| `onResize?(ctx)` / `dispose?()` | resize / cleanup |

`ctx` provides `selected(): { id, title, tool, cwd, command, state }` (including the **resume command**, so extensions need no knowledge of core internals), `metrics()`, and `notify/redraw/schedule`.

Available extensions: [tui-panes](https://github.com/Zzz210s/tui-panes) (same-page split panes).

**Extension-free installs stay extension-free**: with no extension loaded, no extension wording appears anywhere in the UI — the footer lists only the core keys, and pressing `Enter` on a historical session just says the session is not running (use `a` to attach). Extension hints (e.g. `Enter 分屏打开`) show up only once an extension is actually loaded.

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

Working on both this repo and the [tui-panes](https://github.com/Zzz210s/tui-panes) extension? Link the local checkout so edits to the extension take effect immediately (nothing is written to `package.json` or the lock file):

```bash
npm run dev:link -- ../tui-panes     # path to your local tui-panes checkout
npm test
```

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

## Performance

Everything is cached on disk under `~/.ai-session-hub/cache/`, keyed by file fingerprints, so repeat runs are cheap:

| Operation | Cold | Warm |
|---|---|---|
| `ais list` (71 sessions, live probe) | ~4.6 s | **~0.25 s** |
| TUI first frame / list ready | ~1.2 s / ~2.2 s | ~1.2 s / ~2.2 s |

What made it slow, and what was fixed:

1. **UIA enumerated every top-level window** (`TrueCondition`) while probing Windows Terminal tabs — each child property read is a cross-process call, so the probe took ~15 s. It now filters by window class server-side: **~1.3 s**.
2. **`Get-CimInstance Win32_Process` without a server-side filter** transferred ~350 rows; it now filters by process name.
3. **Nothing was cached** — the TUI re-ran the whole probe every 3 s. Now: live probe cached for 8 s (`AIS_LIVE_TTL_MS`; the TUI uses 15 s), and per-file parse results cached by size+mtime (`AIS_SCAN_TTL_MS`, default 24 h).
4. **The TUI waited for the first load before painting** — it now paints immediately ("正在探测会话…") and fills in when the load lands.

Cache controls:

```bash
ais list --no-cache        # bypass both caches once
AIS_CACHE=0 ais            # disable caching entirely
AIS_LIVE_TTL_MS=3000       # live probe TTL (0 = always probe)
AIS_SCAN_TTL_MS=0          # disable the per-file scan cache
rm -rf ~/.ai-session-hub/cache   # clear
```

