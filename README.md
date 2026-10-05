# ai-session-hub

**English** | [简体中文](./README.zh-CN.md)

A host-level **AI session overview** for your terminal (TUI): one keyboard-driven board listing every **running** and **historical** session of pi / Claude Code / opencode on this machine, annotated and searchable — press Enter to jump to the terminal window that owns it, open it in a **split pane**, or hand the terminal over to it. It also lists sessions from the **Zed** and **DeepSeek Harness** GUI apps (metadata only — neither has a terminal to hand over to).

```
 AI 会话总览                          共 42 | 运行中 3 | 需关注 1
 1 运行中 3  2 需关注 1  3 全部 42  4 历史 39        搜索: config|
 > pi      auth-refactor          auth-refactor
 * pi      docs-cleanup           pi | > tool
   pi      perf-tuning            工作目录  ~/work/api
 ? claude  bug-1234              更新时间  刚刚
 ! opencode build-failure        创建时间  2026/09/18 10:22
                                  会话体积  6.1 MB
                                  进程      pid 4242
                                  终端标签  窗口 12345 - 第 3 个
                                  会话文件  ~/.pi/agent/sessions/...jsonl
 a 接管终端 | f 聚焦窗口 | c 复制 | d 删除 | r 刷新 | 1-4 筛选 | / 搜索 | q 退出
```

The list keeps only **tool + session name** (names you set with `/name` are highlighted in bright yellow); everything else — directory, age, size, pid, terminal tab, session file — lives in the right-hand detail pane.

## The problem

With several AI CLIs open at once, you cannot tell from the tab strip which window is doing what, which one is waiting for you, or where that session from three days ago lives. Existing tools are either *session launchers* (they spawn and own the agents, so they know everything) or *session viewers* for one vendor. Nothing answers: **"what is running on my machine right now, and how do I get back to it?"**

This tool fills that gap: it discovers sessions you already started, annotates them, and gives you one keypress to reach them.

## Features

| Feature | Notes |
|---|---|
| Session discovery | pi: `~/.pi/agent/sessions/**/*.jsonl` · Claude: `~/.claude/projects/**/*.jsonl` · opencode: `~/.local/share/opencode/opencode.db` · Zed: `%LOCALAPPDATA%\Zed\threads\threads.db` (GUI, metadata only) · DeepSeek Harness: `$DSH_HOME/storages/session_projcache/sessions/` (GUI, metadata only) |
| Liveness | heartbeat registry (exact) > terminal tab title match (locates the tab) > process start time vs session creation time (fallback) |
| Status annotation | parses the glyph written by pi-tab-status into `*` thinking / `>` running a tool / `\|` waiting / `?` possibly stalled / `x` error / `.` idle; sessions needing you are flagged `!` and can be filtered with `2` |
| Focus window | selects the matching Windows Terminal tab via UI Automation and brings the window forward |
| Split panes (**provided by an extension**) | several sessions running side by side in the same page: each pane is a real PTY whose output is emulated and composed into this program (engine: the [tui-panes](https://github.com/Zzz210s/tui-panes) extension) |
| Hand over terminal (attach) | runs `pi --session <file>` / `claude --resume <id>` in the foreground; this program **fully suspends itself** meanwhile and resumes when the session exits |
| Copy resume command | one key to put the exact command on your clipboard |
| Live refresh | 3-second poll; redraws only when the composed screen actually changes |
| Extensions | the core can be extended (split panes come from the [tui-panes](https://github.com/Zzz210s/tui-panes) extension); the core references no concrete extension and works fine without any |

## Install

**One-command install** (grab the artifact for your platform, unpack, run the installer):

| Platform | Download | Install |
|---|---|---|
| Windows | `ai-session-hub-<version>-windows.zip` | unpack, then `powershell -ExecutionPolicy Bypass -File install.ps1` |
| Linux | `ai-session-hub-<version>-linux.tar.gz` | unpack, then `./install.sh` |

Artifacts live on the [Releases](https://github.com/Zzz210s/ai-session-hub/releases) page; the very same installers are in the repo:

```bash
./install.sh                                  # Linux: installs to ~/.local/share/ai-session-hub, command at ~/.local/bin/ais
./install.sh --yes --install-node             # also fetch official Node 24 from nodejs.org when missing
./install.sh --uninstall                      # remove program dir + PATH entry

powershell -ExecutionPolicy Bypass -File install.ps1            # Windows: installs to %LOCALAPPDATA%\Programsi-session-hub
powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -InstallNode
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

The installer does exactly four things: check Node (>= 24), copy the program, add the command directory to the **user** PATH (no admin needed), run `ais doctor` once. It never clones repos, never runs someone else's `setup.sh`, never touches other config; the session cache (`~/.ai-session-hub`) and the heartbeat registry (`~/.ai-sessions`) survive uninstall.

**Manual install** (run straight from a clone):

```bash
git clone https://github.com/Zzz210s/ai-session-hub.git ~/ai-session-hub
bash ~/ai-session-hub/setup.sh        # optional: installs the pi heartbeat extension + creates ~/bin/ais
~/ai-session-hub/bin/ais              # or just run the launcher shipped in the repo (resolves its own path)
```

Zero required dependencies for the core: listing, filtering, focusing and attach need only **Node >= 24**. The **split-pane** feature needs the optional `tui-panes` package:
```bash
npm install          # installs tui-panes (optionalDependency)
```

**Platform differences**:

| | Windows | Linux |
|---|---|---|
| Live probe | PowerShell + UI Automation (processes + Windows Terminal tabs) | `ps` (processes) + heartbeat registry |
| Focus a window | UI Automation selects the tab | `wmctrl` or `xdotool` (either one) |
| Deleting a session | Windows Recycle Bin (restorable in Explorer) | freedesktop trash (`~/.local/share/Trash`) |
| Resume in a new window | new Windows Terminal tab | tmux window, or `$TERMINAL` / `x-terminal-emulator` |

macOS is not supported yet (BSD `ps` lacks `-o etimes`, so the live probe cannot see processes; the installer says so plainly).

## Startup self-update

Before `ais` opens the board it runs the update commands for every AI CLI and its plugins, then starts sessions on the refreshed environment — so a session never runs on a stale CLI or plugin set.

| Order | Command | Failure handling |
|---|---|---|
| 1 | `pi update` | **strict**: a failure is reported in the summary |
| 2 | `pi update --extensions` | **strict** |
| 3 | `claude update` · `claude plugin update` · `opencode upgrade` · `npm i -g @openai/codex@latest` · `npm i -g @google/gemini-cli@latest` | **best effort**: a step is only planned for an installed CLI, and a failure never blocks startup |

- **GUI apps are version-probed only, on Windows**: Zed and DeepSeek Harness ship their own updaters, so ais reports their versions but never upgrades them — and only on Windows, where the probe reads the uninstall registry (on Linux no version is reported); a global `@deepseek-ai/dsh` CLI is added as a best-effort step only when installed (the summary says whether it was skipped or updated)
- **No version or change detection**: the same sequence runs on every launch (nothing to install means it just no-ops)
- **Standalone**: it only touches the CLIs and their plugins — it never `git pull`s another repo or runs someone else's `setup.sh` (pinned by `test/standalone.test.js`)
- **Skip it**: `ais --no-update` or `AIS_NO_UPDATE=1 ais`
- **Never blocks**: a failing step only shows up in the summary, e.g. `[ais] 启动前自更新: 3/4 步完成,失败: 更新 pi 扩展`
- **Windows specifics**: every command goes through the **absolute Git Bash** path (a bare `bash` can land in WSL), and `.cmd` targets are forwarded via `cmd.exe` (`execFile` cannot run `.cmd` — the reason “更新 pi 扩展” kept failing earlier)
- **Visible exit reason**: the TUI prints e.g. `已退出(q)` on exit, telling a keypress apart from an abnormal exit

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
| `Esc` | while searching: cancel the search and clear the query |
| `Enter` | while searching: finish and keep the filter |
| `Backspace` | while searching: delete a character; press once more on an empty query to leave search |
| `r` | refresh now |
| `q` / `Esc` / `Ctrl+C` | quit (the reason is printed on exit, e.g. `已退出(q)`) |

GUI sessions (Zed / DeepSeek Harness) use a different key set — see [GUI sessions](#gui-sessions-zed--deepseek-harness) below.

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
ais list --fast          # fast mode: live data may lag <=60s, steady ~0.2s (the strict path can wait 1-16s for a probe)
ais gc [--yes]           # drop stale heartbeats (preview by default; dead pid over 24h, or anything over 7 days)
ais --no-update          # skip the startup self-update (same as AIS_NO_UPDATE=1)
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
| dsh | `#4d6bfe` (DeepSeek blue) | 63 |
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
├── scan/             session stores: pi.ts / claude.ts / opencode.ts / zed.ts / dsh.ts / io.ts (head+tail read, streamed marker scan)
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
| Session discovery | dozens of sessions across all five store formats (pi JSONL, Claude JSONL, opencode SQLite, Zed SQLite, DSH metadata) |
| Liveness | every running session matched to its terminal tab index and status glyph |
| Focus window | selects the tab and brings the window forward (verified repeatedly) |
| Split panes | pane renders the session's real output and accepts input |
| TUI rendering | verified with a real terminal emulator at 80/100/120/226 columns — no wrapping or drift |
| Unit tests | `node --test test/*.test.js` — all green (parsing, correlation, formatting, fuzzy match, rendering, keys, screen suspend) |
| Startup | full scan ≈ 1 second |

## GUI sessions (Zed / DeepSeek Harness)

Zed and DeepSeek Harness are desktop apps whose sessions never live in a terminal, yet their metadata is discovered and listed alongside the CLI sessions:

| App | Session store | What ais reads |
|---|---|---|
| Zed | `%LOCALAPPDATA%\Zed\threads\threads.db` (Linux: `~/.local/share/zed/threads/threads.db`) | thread metadata from SQLite: title, created/updated times, project (`folder_paths`), parent thread; thread bodies are zstd BLOBs and are **never decompressed** |
| DeepSeek Harness | metadata under `$DSH_HOME` (default `~/.dsh`) in `storages/session_projcache/sessions/`, plus bodies at `sessions/<project-slug>/<id>/session.v4.jsonl.zstd` | metadata: title, timestamps, project, size; bodies are **never decompressed** |

**Keys** (a GUI session has no terminal, so they differ from a CLI session):

| Key | Action |
|---|---|
| `Enter` / `f` | focus the app window (there is no terminal to hand over) |
| `c` | copy the session info — where to look it up in the app, **not** a resume command |
| `a` | says plainly that a GUI app has no terminal to hand over |
| `d` | delete — **DeepSeek Harness only**; Zed is refused (its thread store is SQLite, deleting rows risks corrupting it) |

**Limits**:

- Neither app offers a way to open one specific session, so ais cannot bring a session forward, and there is no terminal to hand over to (a desktop app has no command-line resume entry point)
- **Zed threads cannot be deleted from ais** — the store is SQLite and deleting rows risks corrupting the app's data; delete them inside Zed
- **DeepSeek Harness sessions can be deleted**: ais moves both the session directory and its `session_projcache` metadata entry to the trash together (a single path pair, not a database row)

## Scope & limits

- **Covered**: pi (name/topic/status/focus/attach/panes), Claude Code (summary/topic/attach/panes), opencode (list/attach/panes), Zed (thread metadata, read-only), DeepSeek Harness (session metadata, read-only, deletable)
- **Not covered**: Gemini/Antigravity, cross-machine
- **Limits**: both GUI apps are metadata-only and a specific session cannot be opened inside them (see above); without heartbeats, tab matching relies on the session name; `psutil.open_files()` is avoided (unreliable on Windows); Claude's `~/.claude/ide/*.lock` is never read (it contains authToken)

## Roadmap

1. Gemini/Antigravity (`brain/<id>/`) collector
2. Session notes/tags/archiving; usage panel; hook-driven instant refresh
3. Panes: draggable ratios, scrollback inside a pane (engine: [tui-panes](https://github.com/Zzz210s/tui-panes))

## License

MIT

## Performance

Everything is cached on disk under `~/.ai-session-hub/cache/`, keyed by file fingerprints, so repeat runs are cheap:

| Operation | Cold | Warm |
|---|---|---|
| `ais list` (71 sessions, live probe) | ~4.6 s | **~0.25 s** |
| TUI first frame (stale-while-revalidate) | **~0.3 s** | **~0 s** |
| `ais list` strict path (waits for a real probe) | 1.2-16 s | same (PowerShell variance) |
| `ais list --fast` (live snapshot <=60 s old) | ~0.2 s | ~0.2 s |

What made it slow, and what was fixed:

1. **UIA enumerated every top-level window** (`TrueCondition`) while probing Windows Terminal tabs — each child property read is a cross-process call, so the probe took ~15 s. It now filters by window class server-side: **~1.3 s**.
2. **`Get-CimInstance Win32_Process` without a server-side filter** transferred ~350 rows; it now filters by process name.
3. **Nothing was cached** — the TUI re-ran the whole probe every 3 s. Now: live probe cached for 8 s (`AIS_LIVE_TTL_MS`; the TUI uses 15 s), and per-file parse results cached by size+mtime (`AIS_SCAN_TTL_MS`, default 24 h).
4. **The TUI waited for the first load before painting** — it now paints immediately and **renders the previous snapshot while refreshing in the background** (see below).

### Stale-while-revalidate

The PowerShell probe measures **1.2-2.3 s** (6-16 s cold) and the session scan 0.3-1.2 s on this machine. Blocking the first frame on either is exactly the "meaningless blank stretch after startup".

Both TUI loads (first frame and the 3-second refresh) therefore pass `staleLive` + `staleSessions`:

- cache is fresh → use it, zero cost
- cache is expired but younger than 10 minutes (`AIS_LIVE_STALE_MS`) → **render it right away**, re-probe/re-scan in the background; the next refresh (≤3 s later) is current
- cache is too old or missing → fetch synchronously

The CLI (`ais list` / `ais doctor`) passes neither flag: it always probes and scans for real.

### Cache tiers and hit rate (measured)

The board refreshes every 3 seconds while the two expensive jobs are the session scan (0.3-2 s) and the PowerShell probe (1.2-2 s). Caching is therefore split by **how fast the data actually changes**:

| Data | Churn | Strategy | Measured |
|---|---|---|---|
| Session list (scan result) | low (only on create/delete/new content) | structural fingerprint (session dir mtimes) + **20 s** ceiling; no rescan when unchanged, rescans run in a **worker thread** | 1 rescan per 20 refreshes |
| Heartbeats + probe snapshot (running/working/waiting) | high | read fresh every time (~25 ms); the probe keeps its own 15 s snapshot cache | board state never lags |
| Per-session-file parse | active sessions keep growing | cached by size+mtime, **incremental**: only the bytes appended since last read | cold 10-24 s -> **~2 s**, warm 0.2 s |

The earlier implementation cached the whole view under a fixed 5 s TTL: measured **55% hit rate** at a 3 s refresh — a pointless background rescan every 5 s even when nothing changed. Now:

```
views cache hit rate   55% -> 95% (19 of 20 refreshes served from cache)
single load            30-70 ms (cold first frame under 0.3 s)
session scan           cold 1-2 s, warm 0.2 s
```

### Rescans never block the UI (worker thread)

The session-list rescan runs in its own thread (`src/scan/worker.ts`): the first read of a 206 MB session file took over ten seconds here and a fully cold scan can run for minutes — on the main thread the UI would simply freeze. The main thread now only consumes results.

```
main-thread worst pause   minutes -> 120 ms (measured while a worker was scanning)
first frame               35-128 ms (renders from cache, does not wait for the scan)
very first run (no cache) 43 ms (empty board) -> all 35 sessions appear 8 s later
cache write-back          0.3 s (warm) / 7-10 s (active sessions appending)
```

- One scan at a time; a worker that errors, exits early, or hangs past 10 minutes is dropped (the old cache stays), and the next refresh retries
- The worker flushes its parse results, so the next scan still hits the fingerprint cache (third run: 0.3 s)
- Because blocking is gone, the rescan ceiling dropped from 60 s to **20 s** — a rename only changes file content, never the directory mtime, so rescanning is the only way the board can follow it

Session-name lookup: session files are append-only, so **with a cache only the appended bytes are read** (the normal path, a few ms); without one it walks backwards from the end in chunks, **with no window cap**, until the last `session_info` is found (206 MB scanned in 175 ms here).

> One trap worth recording: an earlier version capped that backward walk at "the last 8 MB" and fell back to the first 256 KB of the file. A name far from the end was missed, the head fallback returned the **first** name, and the visible symptom was **ais showing the old name after a rename**. Windowed lookup was simply wrong; it is uncapped again.

### Heartbeat registry GC

A crashed or killed session does not remove its heartbeat file (a clean exit does), so the registry can accumulate hundreds or thousands of entries in a few weeks — and every read stats+reads all of them. Cleanup rules: broken or unparseable records, a dead pid older than 24h, or anything older than 7 days (regardless of pid — **pid reuse** is real on this machine, so age alone cannot be trusted).

- **Automatic**: the pi / claude heartbeat integrations sweep on session start (`integrations/pi-heartbeat.ts`, `integrations/claude-heartbeat.mjs`)
- **Manual**: `ais gc` (preview) / `ais gc --yes`; `ais doctor` reports "N valid / M files in the directory"
- Measured here: 459 -> 34 files took the registry read from **143 ms to 22 ms**

### PowerShell engine

`windows.ps1` / `focus.ps1` / `recycle.ps1` all run under PowerShell 7 (pwsh) — each was verified — but the default stays with the bundled `powershell.exe`, because five interleaved rounds of `windows.ps1` measured:

| Engine | Min | Avg |
|---|---|---|
| `powershell.exe` | **1254 ms** | **1363 ms** |
| `pwsh` 7 | 1431 ms | 1714 ms |

To switch: `AIS_PWSH=C:/path/to/pwsh.exe ais` (a broken pwsh falls back to powershell.exe automatically instead of failing every probe).

### Startup self-update progress

Every step prints a start line and a result line (with elapsed time; failures carry the reason), so updates are no longer a silent wait.
**Steps of different tools run in parallel** (two steps of the same tool stay ordered; npm global installs share one group): 4 steps went from 11.7 s serial to ~11 s here, with the pi group as the long pole — the win is bigger when claude / npm are the slow ones:

```
[ais] 执行 4 项更新…
[ais] 更新 pi 本体…
[ais] 更新 pi 本体 完成(3.2s)
[ais] 更新 pi 扩展 失败(4.1s): 需要先 ...
[ais] 启动前自更新: 3/4 步完成,失败: 更新 pi 扩展
```

Cache controls:

```bash
ais list --no-cache        # bypass both caches once
AIS_CACHE=0 ais            # disable caching entirely
AIS_LIVE_TTL_MS=3000       # live probe TTL (0 = always probe)
AIS_LIVE_STALE_MS=60000    # how old a cached live snapshot may be for the first TUI frame
AIS_SCAN_TTL_MS=0          # disable the per-file scan cache
rm -rf ~/.ai-session-hub/cache   # clear
```

