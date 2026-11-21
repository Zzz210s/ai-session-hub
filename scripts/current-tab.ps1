# Which Windows Terminal tab are we running in?
#
# Prints {"hwnd":"...","windowPid":N,"index":N,"title":"..."} for the selected tab of the
# Windows Terminal window that currently has the focus, or "null" when Windows Terminal
# is not in front. `ais` uses it to put the focus back on its own tab after opening a new
# one (`wt new-tab` always activates the new tab; --no-focus is still an open feature
# request, microsoft/terminal#17460).
#
# 2026-11-21: this used to dot-source windows.ps1 -TabsOnly. That path also enumerates every
# process (Get-CimInstance Win32_Process) and walks the UIA tree of every window: measured
# 8.5-12.7 s per call on this machine, and `ais` paid it before it could open a session.
# Now it is self-contained: UIA on the foreground window only, no process enumeration.
# Measured afterwards: see the CHANGELOG entry.
#
# ASCII-only comments on purpose (PowerShell 5.1 reads non-BOM files as ANSI).
param()

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AisFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

$fgHwnd = [IntPtr]::Zero
try {
  $h = [AisFg]::GetForegroundWindow()
  $cls = New-Object System.Text.StringBuilder 128
  [void][AisFg]::GetClassName($h, $cls, 128)
  if ($cls.ToString() -eq "CASCADIA_HOSTING_WINDOW_CLASS") { $fgHwnd = $h }
} catch { }
if ($fgHwnd -eq [IntPtr]::Zero) { Write-Output "null"; return }

$windowPid = 0
try {
  $tmp = 0
  [void][AisFg]::GetWindowThreadProcessId($fgHwnd, [ref]$tmp)
  $windowPid = [int]$tmp
} catch { }

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($fgHwnd)
  if ($null -eq $root) { Write-Output "null"; return }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $index = 0
  $hit = $null
  foreach ($t in $tabs) {
    $selected = $false
    try {
      $pattern = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $selected = [bool]$pattern.Current.IsSelected
    } catch { }
    if ($selected -and $null -eq $hit) {
      $hit = [ordered]@{ index = $index; title = [string]$t.Current.Name }
    }
    $index++
  }
  if ($null -eq $hit) { Write-Output "null"; return }
  [ordered]@{
    hwnd      = ([int64]$fgHwnd).ToString()
    windowPid = $windowPid
    index     = [int]$hit.index
    title     = [string]$hit.title
  } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine("current-tab probe failed: " + $_.Exception.Message)
  Write-Output "null"
}
