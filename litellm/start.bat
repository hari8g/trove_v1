@echo off
REM Start LiteLLM proxy for Trove (Windows).
REM Double-click this file or run: start.bat

cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
    echo ERROR: PowerShell is required.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
exit /b %ERRORLEVEL%
