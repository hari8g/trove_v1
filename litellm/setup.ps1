# Create venv and install LiteLLM (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host 'ERROR: uv is required. Install: https://docs.astral.sh/uv/getting-started/installation/'
    exit 1
}

Write-Host 'Creating virtual environment...'
uv venv --python 3.12 .venv

Write-Host 'Installing LiteLLM...'
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

Write-Host ''
Write-Host 'Done. Next steps:'
Write-Host '  1. copy .env.example .env'
Write-Host '  2. Fill in AWS credentials in .env'
Write-Host '  3. .\start.ps1   (or double-click start.bat)'
