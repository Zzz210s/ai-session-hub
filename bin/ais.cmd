@echo off
rem ais —— PowerShell / cmd 下的启动器(等价于 Git Bash 的 ~/bin/ais)
setlocal
set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "REPO=%%~fI"
node "%REPO%\src\cli.ts" %*
