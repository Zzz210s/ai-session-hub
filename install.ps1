<#
  ai-session-hub 一键安装(Windows)

  用法(在解压出来的目录里):
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -InstallNode
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall

  做什么:
    1. 检查 Node(需要 >= 24;缺了可以 -InstallNode 用 winget 装)
    2. 把程序复制到 %LOCALAPPDATA%\Programs\ai-session-hub(可用 -Dir 改)
    3. 生成 %LOCALAPPDATA%\Programs\ai-session-hub\bin\ais.cmd,并把该目录加入**用户** PATH(不需要管理员)
    4. 跑一次 ais doctor 自检(只读)
  不做什么:不拉任何仓库、不跑别人的 setup.sh、不动别人的配置(与项目"独立程序"的定位一致)。

  卸载:-Uninstall 会删程序目录并撤掉 PATH 条目;会话缓存与心跳注册表留在 ~/.ai-session-hub 与 ~/.ai-sessions。
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$InstallNode,
  [switch]$Uninstall,
  [string]$Dir
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA "Programs\ai-session-hub" }
$binDir = Join-Path $Dir "bin"
$shim = Join-Path $binDir "ais.cmd"
$version = "unknown"
try {
  $version = (Get-Content (Join-Path $scriptDir "package.json") -Raw | ConvertFrom-Json).version
} catch { }

function Write-Step($text) { Write-Host "[ais] $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  注意 $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  失败 $text" -ForegroundColor Red }

function Get-UserPath {
  $value = [Environment]::GetEnvironmentVariable("Path", "User")
  if ([string]::IsNullOrEmpty($value)) { return @() }
  return $value.Split(";", [StringSplitOptions]::RemoveEmptyEntries)
}

function Set-UserPath([string[]]$entries) {
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

function Confirm-Yes([string]$question) {
  if ($Yes) { return $true }
  $answer = Read-Host "$question [y/N]"
  return $answer -match "^(y|yes)$"
}

Write-Host ""
Write-Host "ai-session-hub $version - AI 会话总览与跳转(Windows 安装器)" -ForegroundColor White
Write-Host "安装目录: $Dir"
Write-Host ""

# ---------- 卸载 ----------
if ($Uninstall) {
  Write-Step "卸载"
  if (Test-Path $Dir) {
    Remove-Item $Dir -Recurse -Force
    Write-Ok "已删除 $Dir"
  } else {
    Write-Warn2 "目录不存在,跳过删除"
  }
  $entries = Get-UserPath | Where-Object { $_ -ne $binDir }
  Set-UserPath $entries
  Write-Ok "已从用户 PATH 移除 $binDir"
  if (Test-Path (Join-Path $env:APPDATA "npm\ais.cmd")) { Write-Warn2 "另外发现 $env:APPDATA\npm\ais.cmd(可能是旧的 npm 安装),需要时手动删除" }
  Write-Host ""
  Write-Host "会话缓存(~/.ai-session-hub)与心跳注册表(~/.ai-sessions)已保留,如需清理请手动删除。" -ForegroundColor DarkGray
  exit 0
}

# ---------- 1. Node ----------
Write-Step "检查 Node.js(需要 >= 24)"
$nodeVersion = $null
try { $nodeVersion = (& node -v) 2>$null } catch { }
$major = 0
if ($nodeVersion -match "^v(\d+)") { $major = [int]$Matches[1] }
if ($major -lt 24) {
  $shown = if ($nodeVersion) { $nodeVersion } else { "未安装" }
  Write-Warn2 "当前 Node: $shown,需要 24 或更高"
  $install = $InstallNode -or (Confirm-Yes "用 winget 安装 Node.js LTS?")
  if ($install) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Write-Fail "没有 winget,请手动安装 Node.js 24+ 后重跑:https://nodejs.org/"
      exit 1
    }
    Write-Step "winget 安装 OpenJS.NodeJS.LTS(装完请新开一个终端让 PATH 生效)"
    & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget 安装失败(退出码 $LASTEXITCODE)"; exit 1 }
    Write-Ok "Node 已安装;本次安装继续,若下面自检报找不到 node,请新开终端后重跑本脚本"
  } else {
    Write-Fail "缺少 Node 24+。可执行:winget install OpenJS.NodeJS.LTS,或到 https://nodejs.org/ 下载"
    exit 1
  }
} else {
  Write-Ok "Node $nodeVersion"
}

# ---------- 2. 复制程序 ----------
Write-Step "复制程序文件 -> $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$exclude = @(".git", "node_modules", ".codegraph")
Get-ChildItem -Path $scriptDir -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $Dir -Recurse -Force
}
Write-Ok "已复制(版本 $version)"

# ---------- 3. 命令入口 + PATH ----------
Write-Step "检查命令入口"
$entry = Join-Path $Dir "src\cli.ts"
if (Test-Path $shim) {
  Write-Ok $shim
} else {
  Write-Fail "缺少 $shim(程序文件没复制完整)"
  exit 1
}

$entries = Get-UserPath
if ($entries -contains $binDir) {
  Write-Ok "用户 PATH 已包含 $binDir"
} else {
  Set-UserPath ($entries + $binDir)
  Write-Ok "已把 $binDir 加入用户 PATH(新开终端生效)"
}
if (($env:Path -split ";") -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }

# ---------- 4. 自检 ----------
Write-Step "自检: ais doctor"
try {
  & node --no-warnings $entry doctor | Select-Object -First 12
  Write-Ok "自检通过"
} catch {
  Write-Warn2 "自检未通过($($_.Exception.Message));可手动运行:ais doctor"
}

Write-Host ""
Write-Host "装好了。新开一个终端,输入 ais 打开看板。" -ForegroundColor Green
Write-Host "  ais            看板(↑↓ 移动,Enter 打开,/ 搜索,q 退出)" -ForegroundColor DarkGray
Write-Host "  ais doctor     自检    ais list --live  只看运行中    ais gc --yes  清理心跳" -ForegroundColor DarkGray
Write-Host "  想要分屏面板:在 $Dir 里执行 npm install(需要 git + 联网)" -ForegroundColor DarkGray
Write-Host "  卸载:powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall" -ForegroundColor DarkGray
