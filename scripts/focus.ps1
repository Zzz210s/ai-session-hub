# Focus a Windows Terminal tab: select tab by index via UI Automation and bring the window forward.
# ASCII-only on purpose (PowerShell 5.1 ANSI script parsing).
param(
  [int]$WindowPid = 0,
  [int]$TabIndex = -1,
  [string]$Hwnd = ""
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
$children = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

if ($Hwnd -ne "") {
  # 直接聚焦某个窗口句柄(控制台窗口场景)
  $hwndVal = 0
  try { $hwndVal = [int64]$Hwnd } catch { $hwndVal = 0 }
  if ($hwndVal -eq 0) { Write-Output "BAD_HWND"; exit 5 }
  $ptr = [IntPtr]$hwndVal
  if ([WinFocus]::IsIconic($ptr)) { [void][WinFocus]::ShowWindow($ptr, 9) }
  if ([WinFocus]::SetForegroundWindow($ptr)) { Write-Output "FOCUSED" } else { Write-Output "FOCUS_FAILED"; exit 6 }
  exit 0
}

$targetWindow = $null
foreach ($w in $children) {
  try {
    if ($Hwnd -ne "") {
      if ([string]$w.Current.NativeWindowHandle -eq $Hwnd) { $targetWindow = $w; break }
      continue
    }
    if ([int]$w.Current.ProcessId -eq $WindowPid) { $targetWindow = $w; break }
  } catch { }
}

if ($null -eq $targetWindow) { Write-Output "WINDOW_NOT_FOUND"; exit 2 }

$tabCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$tabs = $targetWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)

if ($TabIndex -lt 0 -or $TabIndex -ge $tabs.Count) { Write-Output ("TAB_INDEX_OUT_OF_RANGE:" + $tabs.Count); exit 3 }

$tab = $tabs.Item($TabIndex)
$ok = $false
try {
  $pat = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $pat.Select()
  $ok = $true
} catch { $ok = $false }

$hwndVal = 0
try { $hwndVal = [int]$targetWindow.Current.NativeWindowHandle } catch { $hwndVal = 0 }
if ($hwndVal -ne 0) {
  $ptr = [IntPtr]$hwndVal
  if ([WinFocus]::IsIconic($ptr)) { [void][WinFocus]::ShowWindow($ptr, 9) } # SW_RESTORE
  [void][WinFocus]::SetForegroundWindow($ptr)
}

if ($ok) { Write-Output "FOCUSED" } else { Write-Output "SELECT_FAILED"; exit 4 }
