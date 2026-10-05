# GUI app window enumeration for ais: Zed / DeepSeek Harness top-level windows.
# Called by windows.ps1 (not dot-sourced); returns an array of ordered maps
# { hwnd; pid; process; title }. ASCII-only comments on purpose (PS 5.1 ANSI).
#
# Notes:
#   - $guiCb must stay referenced until EnumWindows returns: a scriptblock
#     marshalled to a delegate can otherwise be collected mid-enumeration.
#   - The owning process is matched before any per-window string work; the set of
#     interesting processes is tiny, so walking every top-level window is cheap.
#   - [int64] cast: window handles above 0x7fffffff are negative as [int].

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AisGui {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

$script:guiNames = @{}
foreach ($nm in @("zed", "DeepSeek Harness")) {
  try {
    foreach ($gp in @(Get-Process -Name $nm -ErrorAction Stop)) { $script:guiNames[[int]$gp.Id] = $gp.ProcessName + ".exe" }
  } catch { }
}

$script:guiRows = New-Object System.Collections.ArrayList
if ($script:guiNames.Count -gt 0) {
  $guiCb = [AisGui+EnumProc]{
    param($h, $l)
    $winPid = [uint32]0
    [void][AisGui]::GetWindowThreadProcessId($h, [ref]$winPid)
    if (-not $script:guiNames.ContainsKey([int]$winPid)) { return $true }
    if (-not [AisGui]::IsWindowVisible($h)) { return $true }
    $clsBuf = New-Object System.Text.StringBuilder 256
    [void][AisGui]::GetClassName($h, $clsBuf, 256)
    $cls = $clsBuf.ToString()
    # Console windows are covered by the consoleWindows probe.
    if ($cls -eq "ConsoleWindowClass" -or $cls -eq "CASCADIA_HOSTING_WINDOW_CLASS") { return $true }
    $titleBuf = New-Object System.Text.StringBuilder 512
    [void][AisGui]::GetWindowText($h, $titleBuf, 512)
    $guiTitle = $titleBuf.ToString()
    if ($guiTitle.Length -eq 0) { return $true }
    [void]$script:guiRows.Add([ordered]@{
      hwnd    = ("0x{0:x}" -f [int64]$h)
      pid     = [int]$winPid
      process = $script:guiNames[[int]$winPid]
      title   = $guiTitle
    })
    return $true
  }
  [void][AisGui]::EnumWindows($guiCb, [IntPtr]::Zero)
}
return @($script:guiRows)
