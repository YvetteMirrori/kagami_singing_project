@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "KOTOBA_NODE="
where node >nul 2>nul
if not errorlevel 1 set "KOTOBA_NODE=node"
if not defined KOTOBA_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "KOTOBA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined KOTOBA_NODE (
  echo 请先安装 Node.js 22 或更新版本。
  pause
  exit /b 1
)
echo 网页启动后，请打开 http://127.0.0.1:8787
echo 保持此窗口开启；按 Ctrl+C 停止服务。
"%KOTOBA_NODE%" --env-file-if-exists=.env server.mjs
pause
