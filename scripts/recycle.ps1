<#
  把文件/目录送入 Windows 回收站(不是硬删除)。

  用法: powershell -NoProfile -ExecutionPolicy Bypass -File recycle.ps1 -Path <路径>
  输出: RECYCLED  |  FAIL <原因>

  说明:用 Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory 的
  SendToRecycleBin 选项 —— 由系统接管,用户可在资源管理器里还原。
  UIOption 只有 OnlyErrorDialogs / AllDialogs 两个值(没有 DoNothing,写了会直接报错),
  所以这里保持 OnlyErrorDialogs;万一弹了模态框,调用方的 20 秒超时会让它退回内部回收目录,
  不会无限等下去。
#>
param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Output "FAIL 路径不存在: $Path"
  exit 2
}

try {
  Add-Type -AssemblyName Microsoft.VisualBasic
} catch {
  Write-Output "FAIL 无法加载 Microsoft.VisualBasic: $($_.Exception.Message)"
  exit 3
}

try {
  if (Test-Path -LiteralPath $Path -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Path, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
  Write-Output "RECYCLED"
} catch {
  Write-Output "FAIL $($_.Exception.Message)"
  exit 4
}
