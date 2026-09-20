# Enumerate AI CLI candidate processes and Windows Terminal tabs as JSON.
# ASCII-only on purpose: PowerShell 5.1 reads non-BOM scripts as ANSI.
param(
  [switch]$TabsOnly,
  [switch]$ProcessesOnly
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$result = [ordered]@{ processes = @(); tabs = @() }

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
