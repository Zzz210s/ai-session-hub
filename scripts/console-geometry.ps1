# Report the geometry of the console that hosts this process, plus the Windows Terminal profile name.
# ASCII-only on purpose (PowerShell 5.1 parses scripts with the ANSI code page).
# Output: one line of JSON. Any probe that fails is reported as 0 / false / empty string.
$ErrorActionPreference = 'SilentlyContinue'
# 输出必须是 UTF-8:profile 名可能是中文,PS 5.1 默认按控制台代码页(CP936)写出,
# Node 按 UTF-8 读就会变成乱码,进而 --profile 匹配不上。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false } catch {}

Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

Add-Type -Namespace Native -Name Con -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out CONSOLE_SCREEN_BUFFER_INFO info);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
public struct COORD { public short X; public short Y; }
public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
public struct CONSOLE_SCREEN_BUFFER_INFO {
  public COORD dwSize;
  public COORD dwCursorPosition;
  public short wAttributes;
  public SMALL_RECT srWindow;
  public COORD dwMaximumWindowSize;
}
'@

# 走 CONOUT$ 而不是 [Console]::WindowWidth:后者在 stdout 被重定向时返回 0,
# 而 ais 有可能在管道里被调用。ConPTY 会把窗格的真实列数/行数报给这个结构。
$cols = 0
$rows = 0
try {
  $handle = [Native.Con]::CreateFileW('CONOUT$', 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr]::new(-1)) {
    $info = New-Object Native.Con+CONSOLE_SCREEN_BUFFER_INFO
    if ([Native.Con]::GetConsoleScreenBufferInfo($handle, [ref]$info)) {
      if ($null -ne $info.srWindow.Right -and $null -ne $info.srWindow.Left) {
        $cols = [int]$info.srWindow.Right - [int]$info.srWindow.Left + 1
      }
      if ($null -ne $info.srWindow.Bottom -and $null -ne $info.srWindow.Top) {
        $rows = [int]$info.srWindow.Bottom - [int]$info.srWindow.Top + 1
      }
    }
    [void][Native.Con]::CloseHandle($handle)
  }
} catch {}
if ($cols -le 0 -or $rows -le 0) {
  # [Console]::WindowWidth 在没有控制台时返回 $null(不是抛异常),直接赋值会把 cols 变成 null
  try {
    $fallbackCols = [Console]::WindowWidth
    $fallbackRows = [Console]::WindowHeight
    if ($null -ne $fallbackCols -and [int]$fallbackCols -gt 0) { $cols = [int]$fallbackCols }
    if ($null -ne $fallbackRows -and [int]$fallbackRows -gt 0) { $rows = [int]$fallbackRows }
  } catch {}
}
if ($null -eq $cols) { $cols = 0 }
if ($null -eq $rows) { $rows = 0 }

# Walk up the parent chain: the shell's console is a ConPTY pseudo window, so the real
# window belongs to an ancestor (WindowsTerminal.exe) that has a visible main window.
function Get-AncestorWindow {
  $current = $PID
  for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current"
    if (-not $proc) { return [IntPtr]::Zero }
    $parentId = [int]$proc.ParentProcessId
    if ($parentId -le 0) { return [IntPtr]::Zero }
    $parent = Get-Process -Id $parentId
    if ($parent -and $parent.MainWindowHandle -ne 0) { return $parent.MainWindowHandle }
    $current = $parentId
  }
  return [IntPtr]::Zero
}

$x = 0
$y = 0
$w = 0
$h = 0
$maximized = $false
$hwnd = Get-AncestorWindow
if ($hwnd -ne [IntPtr]::Zero) {
  $rect = New-Object Native.Win+RECT
  if ([Native.Win]::GetWindowRect($hwnd, [ref]$rect)) {
    $x = $rect.Left
    $y = $rect.Top
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
  }
  $maximized = [Native.Win]::IsZoomed($hwnd)
}

# Windows Terminal exports WT_PROFILE_ID (a GUID) to every shell it starts.
$profileName = ''
$wtProfileId = $env:WT_PROFILE_ID
if ($wtProfileId) {
  $settingsPaths = @()
  if ($env:LOCALAPPDATA) {
    $settingsPaths += (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json')
    $packages = Join-Path $env:LOCALAPPDATA 'Packages'
    if (Test-Path $packages) {
      $settingsPaths += Get-ChildItem $packages -Directory -Filter 'Microsoft.WindowsTerminal*' |
        ForEach-Object { Join-Path $_.FullName 'LocalState\settings.json' }
    }
  }
  foreach ($path in $settingsPaths) {
    if (-not (Test-Path $path)) { continue }
    $settings = Get-Content $path -Raw | ConvertFrom-Json
    $hit = $settings.profiles.list | Where-Object { $_.guid -eq $wtProfileId } | Select-Object -First 1
    if ($hit -and $hit.name) { $profileName = [string]$hit.name; break }
  }
}

$profileB64 = ''
if ($profileName) {
  $profileB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($profileName))
}

[pscustomobject]@{
  cols       = $cols
  rows       = $rows
  x          = $x
  y          = $y
  width      = $w
  height     = $h
  maximized  = [bool]$maximized
  profileB64 = $profileB64
} | ConvertTo-Json -Compress
