@echo off
rem ais launcher - portable, no machine-specific paths.
rem Resolves the repo in order: 1) ais.path next to this script  2) %USERPROFILE%\ai-session-hub  3) parent of this script.
rem Keep this file pure ASCII: cmd.exe reads .cmd with the OEM code page, so UTF-8 text breaks parsing.
setlocal
set "HERE=%~dp0"
set "RECORDED="
if exist "%HERE%ais.path" set /p RECORDED=<"%HERE%ais.path"
if defined RECORDED if exist "%RECORDED%\src\cli.ts" (
  node --no-warnings "%RECORDED%\src\cli.ts" %*
  exit /b %ERRORLEVEL%
)
if exist "%USERPROFILE%\ai-session-hub\src\cli.ts" (
  node --no-warnings "%USERPROFILE%\ai-session-hub\src\cli.ts" %*
  exit /b %ERRORLEVEL%
)
for %%I in ("%HERE%..") do if exist "%%~fI\src\cli.ts" (
  node --no-warnings "%%~fI\src\cli.ts" %*
  exit /b %ERRORLEVEL%
)
echo [ais] ai-session-hub repo not found. Tried: 1>&2
if defined RECORDED echo   %RECORDED%   (from ais.path) 1>&2
echo   %USERPROFILE%\ai-session-hub 1>&2
for %%I in ("%HERE%..") do echo   %%~fI 1>&2
echo [ais] Repo on a VHDX/removable drive? Mount it first. Moved it? Re-run the repo's setup.sh. 1>&2
exit /b 1
