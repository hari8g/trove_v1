@echo off
REM Install LiteLLM venv and dependencies (Windows).
REM Double-click or run: setup.bat

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
