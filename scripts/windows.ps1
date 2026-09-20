# Live probe: AI CLI processes + Windows Terminal tabs (+ legacy console windows) as JSON.
#
# ASCII-only comments on purpose: PowerShell 5.1 reads non-BOM files as ANSI, and
# non-ASCII bytes can break parsing.
#
# Two performance/safety notes (both measured on this machine):
#   1. Get-CimInstance must be filtered server-side; enumerating all processes and
#      filtering in PowerShell costs ~0.3s extra and transfers ~350 rows.
#   2. UIA must NOT enumerate every top-level window (TrueCondition): each child
#      property read is a cross-process call, which turned this script from ~1s
#      into ~15s. Filter by window class server-side instead.
#
# UIA types are accessed via reflection: a later Add-Type of inline C# invalidates
# PowerShell's type resolver for UIAutomationClient (measured: "type not found").
param(
  [switch]$TabsOnly,
  [switch]$ProcessesOnly
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = "Continue"

$result = [ordered]@{ processes = @(); tabs = @(); consoleWindows = @() }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AisConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Get-UiaTypes {
  # Load UIAutomation and resolve the types we need (reflection avoids the
  # resolver cache problem caused by the inline Add-Type above).
  # Note: TreeScope lives in UIAutomationTypes, the rest in UIAutomationClient -
  # so search both assemblies for every type.
  $assemblies = @()
  foreach ($name in @("UIAutomationClient", "UIAutomationTypes")) {
    $loaded = [System.Reflection.Assembly]::LoadWithPartialName($name)
    if ($loaded) { $assemblies += $loaded }
  }
  if ($assemblies.Count -eq 0) { throw "UIAutomation assemblies not available" }

  $ae = $null; $pc = $null; $ts = $null; $ct = $null; $sel = $null
  foreach ($a in $assemblies) {
    if (-not $ae) { $ae = $a.GetType("System.Windows.Automation.AutomationElement") }
    if (-not $pc) { $pc = $a.GetType("System.Windows.Automation.PropertyCondition") }
    if (-not $ts) { $ts = $a.GetType("System.Windows.Automation.TreeScope") }
    if (-not $ct) { $ct = $a.GetType("System.Windows.Automation.ControlType") }
    if (-not $sel) { $sel = $a.GetType("System.Windows.Automation.SelectionItemPattern") }
  }
  if (-not $ae -or -not $pc -or -not $ts -or -not $ct -or -not $sel) {
    throw "missing UIA types (ae=$($ae -ne $null) pc=$($pc -ne $null) ts=$($ts -ne $null) ct=$($ct -ne $null) sel=$($sel -ne $null))"
  }

  return [pscustomobject]@{
    AE        = $ae
    PC        = $pc
    CT        = $ct
    SEL       = $sel
    ScopeKids = [Enum]::Parse($ts, "Children")
    ScopeDeep = [Enum]::Parse($ts, "Descendants")
  }
}

if (-not $TabsOnly) {
  $procRows = @()
  $cim = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'claude.exe' OR Name = 'opencode.exe' OR Name = 'bun.exe'" -ErrorAction SilentlyContinue
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

  $result.consoleWindows = $consoleRows
}

if (-not $ProcessesOnly) {
  $rows = @()
  try {
    $uia = Get-UiaTypes
    $rootEl = $uia.AE.GetProperty("RootElement").GetValue($null)
    $classProp = $uia.AE.GetField("ClassNameProperty").GetValue($null)
    $wtCond = [Activator]::CreateInstance($uia.PC, @($classProp, "CASCADIA_HOSTING_WINDOW_CLASS"))
    $windows = $rootEl.FindAll($uia.ScopeKids, $wtCond)

    $wtPids = @()
    try { $wtPids = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }) } catch { $wtPids = @() }

    $controlTypeProp = $uia.AE.GetField("ControlTypeProperty").GetValue($null)
    $tabItem = $uia.CT.GetField("TabItem").GetValue($null)
    $tabCond = [Activator]::CreateInstance($uia.PC, @($controlTypeProp, $tabItem))
    $selPatternId = $uia.SEL.GetField("Pattern").GetValue($null)

    foreach ($w in $windows) {
      $wp = 0
      try { $wp = [int]$w.Current.ProcessId } catch { $wp = 0 }
      if ($wtPids.Count -gt 0 -and ($wtPids -notcontains $wp)) { continue }
      $hwnd = ""
      try { $hwnd = $w.Current.NativeWindowHandle.ToString() } catch { $hwnd = "" }
      $winTitle = ""
      try { $winTitle = $w.Current.Name } catch { $winTitle = "" }
      $tabs = $w.FindAll($uia.ScopeDeep, $tabCond)
      $idx = 0
      foreach ($t in $tabs) {
        $selected = $false
        try {
          $pat = $t.GetCurrentPattern($selPatternId)
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
    }
  } catch {
    # Never fail the whole probe because of UIA; the caller degrades to processes only.
    [Console]::Error.WriteLine("UIA probe failed: " + $_.Exception.Message + " @ " + $_.InvocationInfo.PositionMessage)
  }
  $result.tabs = $rows
}

if (-not $TabsOnly) {
  # Legacy console windows (conhost / standalone PowerShell). ConPTY hands out
  # PseudoConsoleWindow placeholders (0x0 size), which are useless for focusing.
  $consoleRows = @()
  foreach ($row in $procRows) {
    $hwnd = [int64]0
    try {
      [void][AisConsole]::FreeConsole()
      if ([AisConsole]::AttachConsole([uint32]$row.pid)) {
        $hwnd = [int64][AisConsole]::GetConsoleWindow()
        [void][AisConsole]::FreeConsole()
      }
    } catch { }
    if ($hwnd -eq 0) { continue }
    $title = ""
    try {
      $proc = Get-Process -Id $row.pid -ErrorAction SilentlyContinue
      if ($proc) { $title = $proc.MainWindowTitle }
    } catch { }
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
  $result.consoleWindows = $consoleRows
}

$result | ConvertTo-Json -Depth 5 -Compress
