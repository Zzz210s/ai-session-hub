# Which Windows Terminal tab are we running in?
#
# Prints {"hwnd":"...","windowPid":N,"index":N,"title":"..."} for the selected tab of the
# Windows Terminal window that currently has the focus, or "null" when Windows Terminal
# is not in front. `ais` uses it to put the focus back on its own tab after opening a new
# one (`wt new-tab` always activates the new tab; --no-focus is still an open feature
# request, microsoft/terminal#17460).
#
# Why the foreground window and not the parent-process chain: a `wt` window is shared by
# every tab, and the parent chain breaks whenever an intermediate process exits (measured:
# the chain ended at a pid that no longer existed, so the lookup returned nothing). The
# foreground window is exactly what `wt -w 0` means by "current window", and the user is
# looking at it when they press the key.
#
# ASCII-only comments on purpose (PowerShell 5.1 reads non-BOM files as ANSI).
param()

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AisFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@

$fgHwnd = ""
try {
  $h = [AisFg]::GetForegroundWindow()
  $cls = New-Object System.Text.StringBuilder 128
  [void][AisFg]::GetClassName($h, $cls, 128)
  if ($cls.ToString() -eq "CASCADIA_HOSTING_WINDOW_CLASS") { $fgHwnd = ([int64]$h).ToString() }
} catch { }
if (-not $fgHwnd) { Write-Output "null"; return }

# Reuse the tab enumeration instead of duplicating ~100 lines of UIA code. Dot-sourcing
# keeps $result in this scope; its own JSON output is captured and discarded.
$null = . (Join-Path $PSScriptRoot "windows.ps1") -TabsOnly
$tabs = @($result.tabs | Where-Object { [string]$_.hwnd -eq $fgHwnd })
if ($tabs.Count -eq 0) { Write-Output "null"; return }

$hit = @($tabs | Where-Object { $_.selected } | Select-Object -First 1)
if ($hit.Count -eq 0) { $hit = @($tabs | Select-Object -First 1) }

[ordered]@{
  hwnd      = [string]$hit[0].hwnd
  windowPid = [int]$hit[0].windowPid
  index     = [int]$hit[0].index
  title     = [string]$hit[0].title
} | ConvertTo-Json -Compress
