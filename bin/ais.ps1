# ais —— PowerShell 启动器:  ais.ps1 list --live   /   ais.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..')).Path
& node (Join-Path $repo 'src\cli.ts') @args
