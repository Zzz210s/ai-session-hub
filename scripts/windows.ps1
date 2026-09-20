# Enumerate AI CLI candidate processes and Windows Terminal tabs as JSON.
# ASCII-only on purpose: PowerShell 5.1 reads non-BOM scripts as ANSI.
param(
  [switch]$TabsOnly,
  [switch]$ProcessesOnly
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$result = [ordered]@{ processes = @(); tabs = @(); consoleWindows = @() }

# 取得"某个进程所属控制台窗口"的句柄:AttachConsole(pid) -> GetConsoleWindow()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AisConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

if (-not $TabsOnly) {
  $procRows = @()
  $cim = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  foreach ($p in $cim) {
    $cmd = $p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd -notmatch 'pi-coding-agent|@anthropic-ai|claude-code|[\\/]opencode|opencode-ai') { continue }
    $started = ""
    try { $started = $p.CreationDate.ToString("o") } catch { $started = "" }
    $procRows += [ordered]@{
      pid       = [int]$p.ProcessId
      name      = $p.Name
      startedAt = $started
      cmd       = $cmd
    }
  }
  $result.processes = $procRows

  # 控制台窗口(非 Windows Terminal:conhost / Windows PowerShell 控制台等)
  $consoleRows = @()
  foreach ($row in $procRows) {
    $hwnd = 0
    try {
      # 先脱离自身控制台(否则 AttachConsole 会因"已有控制台"失败)
      [void][AisConsole]::FreeConsole()
      $attached = [AisConsole]::AttachConsole([uint32]$row.pid)
      if ($attached) {
        $hwnd = [AisConsole]::GetConsoleWindow().ToInt64()
        [void][AisConsole]::FreeConsole()
      }
    } catch { }
    if ($hwnd -ne 0) {
      $title = ""
      try {
        $proc = Get-Process -Id $row.pid -ErrorAction SilentlyContinue
        if ($proc) { $title = $proc.MainWindowTitle }
      } catch { }
      # 只保留真正的传统控制台窗口:
      #   ConPTY(Windows Terminal)给出的是 PseudoConsoleWindow,尺寸 0x0,聚焦无意义
      $ptr = [IntPtr]$hwnd
      $className = New-Object System.Text.StringBuilder 128
      [void][AisConsole]::GetClassName($ptr, $className, 128)
      $rect = New-Object AisConsole+RECT
      [void][AisConsole]::GetWindowRect($ptr, [ref]$rect)
      $realSize = ($rect.Right - $rect.Left) -gt 0 -and ($rect.Bottom - $rect.Top) -gt 0
      $isPseudo = $className.ToString() -eq 'PseudoConsoleWindow'
      if ([AisConsole]::IsWindowVisible($ptr) -and $realSize -and -not $isPseudo) {
        $consoleRows += [ordered]@{ hwnd = [string]$hwnd; pid = [int]$row.pid; title = $title }
      }
    }
  }
  $result.consoleWindows = $consoleRows
}

if (-not $ProcessesOnly) {
  $rows = @()
  $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $wtPids = @()
  try { $wtPids = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) } catch { $wtPids = @() }
  foreach ($w in $children) {
    try {
      $wp = [int]$w.Current.ProcessId
      if ($wtPids -notcontains $wp) { continue }
      $hwnd = ""
      try { $hwnd = $w.Current.NativeWindowHandle.ToString() } catch { $hwnd = "" }
      $winTitle = ""
      try { $winTitle = $w.Current.Name } catch { $winTitle = "" }
      $tabCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem)
      $tabs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
      $idx = 0
      foreach ($t in $tabs) {
        $selected = $false
        try {
          $pat = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          $selected = [bool]$pat.Current.IsSelected
        } catch { }
        $title = ""
        try { $title = $t.Current.Name } catch { $title = "" }
        $rows += [ordered]@{
          hwnd        = $hwnd
          windowPid   = $wp
          windowTitle = $winTitle
          index       = $idx
          title       = $title
          selected    = $selected
        }
        $idx++
      }
    } catch { }
  }
  $result.tabs = $rows
}

$json = $result | ConvertTo-Json -Depth 5 -Compress
[Console]::Out.Write($json)
