# ais —— PowerShell 启动器(跨机器通用,不含任何本机路径)
# 仓库位置按序解析:① 本脚本旁的 ais.path ② ~/ai-session-hub ③ 本脚本的上级目录。
# 本文件必须存成 UTF-8 with BOM:Windows PowerShell 5.1 对无 BOM 的脚本按 ANSI 读,中文会乱码并报语法错。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @()
$pathFile = Join-Path $here "ais.path"
if (Test-Path -LiteralPath $pathFile) {
  $recorded = (Get-Content -LiteralPath $pathFile -TotalCount 1)
  if ($recorded) { $candidates += $recorded.Trim() }
}
$candidates += (Join-Path $HOME "ai-session-hub")
$candidates += (Split-Path -Parent $here)

foreach ($dir in $candidates) {
  if (-not $dir) { continue }
  $entry = Join-Path $dir "src\cli.ts"
  if (Test-Path -LiteralPath $entry) {
    & node --no-warnings $entry @args
    exit $LASTEXITCODE
  }
}

$nl = [Environment]::NewLine
$tried = $candidates -join ($nl + "  ")
Write-Error ("[ais] 找不到 ai-session-hub 仓库。已尝试:" + $nl + "  " + $tried + $nl + "  · 仓库在虚拟盘/移动盘上?先挂载它(Mount-DiskImage <盘文件>)" + $nl + "  · 换过位置?重跑仓库里的 setup.sh,它会更新 ais.path")
exit 1
