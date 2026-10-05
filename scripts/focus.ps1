# Focus a window (by hwnd) or a Windows Terminal tab (by UIAutomation) and bring it forward.
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@

# Bring a window to the foreground. SetForegroundWindow is refused when the caller
# is not the foreground process, so we escalate through the standard workarounds:
#   1) restore if minimized, then plain SetForegroundWindow
#   2) attach our thread to the foreground window's thread, retry, detach
#   3) tap Alt (keybd_event) so the OS sees user input, retry
#   4) BringWindowToTop, retry
function Invoke-FocusWindow([IntPtr]$ptr) {
  if ([WinFocus]::IsIconic($ptr)) { [void][WinFocus]::ShowWindow($ptr, 9) } # SW_RESTORE
  if ([WinFocus]::SetForegroundWindow($ptr)) { return $true }

  $fg = [WinFocus]::GetForegroundWindow()
  $fgThread = [WinFocus]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $curThread = [WinFocus]::GetCurrentThreadId()
  if ($fgThread -ne 0 -and $fgThread -ne $curThread) {
    [void][WinFocus]::AttachThreadInput($curThread, $fgThread, $true)
    $attached = [WinFocus]::SetForegroundWindow($ptr)
    [void][WinFocus]::AttachThreadInput($curThread, $fgThread, $false)
    if ($attached) { return $true }
  }

  [WinFocus]::keybd_event(0x12, 0, 0, [IntPtr]::Zero) # VK_MENU down
  [WinFocus]::keybd_event(0x12, 0, 2, [IntPtr]::Zero) # VK_MENU up
  if ([WinFocus]::SetForegroundWindow($ptr)) { return $true }

  [void][WinFocus]::BringWindowToTop($ptr)
  if ([WinFocus]::SetForegroundWindow($ptr)) { return $true }
  return $false
}

if ($Hwnd -ne "") {
  # Focus a window handle directly (console window / GUI app window).
  $hwndVal = 0
  try { $hwndVal = [int64]$Hwnd } catch { $hwndVal = 0 }
  if ($hwndVal -eq 0) { Write-Output "BAD_HWND"; exit 5 }
  $ptr = [IntPtr]$hwndVal
  if (Invoke-FocusWindow $ptr) { Write-Output "FOCUSED" } else { Write-Output "FOCUS_FAILED"; exit 6 }
  exit 0
}

$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
$children = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

$targetWindow = $null
foreach ($w in $children) {
  try {
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
if ($hwndVal -ne 0) { [void](Invoke-FocusWindow ([IntPtr]$hwndVal)) }

if ($ok) { Write-Output "FOCUSED" } else { Write-Output "SELECT_FAILED"; exit 4 }
