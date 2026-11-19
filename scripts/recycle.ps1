<#
  把文件/目录送入 Windows 回收站(不是硬删除)。

  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File recycle.ps1 -ListFile <每行一个路径的 UTF-8 文件>
    powershell ... -File recycle.ps1 -Path <路径> [更老的写法,只能给一个]
  输出: 每个路径一行,制表符分隔
          RECYCLED<TAB><路径>
          FAIL<TAB><路径><TAB><原因>
        (兼容老格式:单路径时也接受 `RECYCLED` / `FAIL <原因>`)

  为什么用 -ListFile 而不是 -Path a b:PowerShell 对 [string[]] 只认 `-Path a,b` 这种
  一元写法,`-Path a b` 会把 b 当成找不到的位置参数(实测报 "A positional parameter
  cannot be found"),而路径里可能带逗号 —— 所以改走清单文件,一次进程处理全部路径。

  一次进程启动约 750ms(杀软每次扫 exe),而 DSH 会话要移走"会话目录 + 元数据条目"
  两个路径 —— 逐个起进程等于把删除耗时乘上路径数。

  说明:用 Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory 的
  SendToRecycleBin 选项 —— 由系统接管,用户可在资源管理器里还原。
  UIOption 只有 OnlyErrorDialogs / AllDialogs 两个值(没有 DoNothing,写了会直接报错),
  所以这里保持 OnlyErrorDialogs;万一弹了模态框,调用方的 20 秒超时会让它退回内部回收目录,
  不会无限等下去。
#>
param(
  [string]$ListFile,
  [string[]]$Path
)

$ErrorActionPreference = "Stop"

$targets = @()
if ($ListFile) {
  $targets = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_.Length -gt 0 })
} elseif ($Path) {
  $targets = @($Path)
}

if ($targets.Count -eq 0) {
  Write-Output "FAIL`t`t没有要处理的路径"
  exit 2
}

try {
  Add-Type -AssemblyName Microsoft.VisualBasic
} catch {
  foreach ($p in $targets) { Write-Output "FAIL`t$p`t无法加载 Microsoft.VisualBasic: $($_.Exception.Message)" }
  exit 3
}

$failed = 0
foreach ($p in $targets) {
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Output "FAIL`t$p`t路径不存在"
    $failed++
    continue
  }
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    Write-Output "RECYCLED`t$p"
  } catch {
    Write-Output "FAIL`t$p`t$($_.Exception.Message)"
    $failed++
  }
}

if ($failed -gt 0) { exit 4 }
