# Start LiteLLM proxy for Trove (Windows PowerShell).
# Usage: .\start.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$VenvLiteLLM = Join-Path $PSScriptRoot '.venv\Scripts\litellm.exe'
$EnvFile = Join-Path $PSScriptRoot '.env'
$ConfigFile = Join-Path $PSScriptRoot 'litellm_config.yaml'

function Import-DotEnv {
    param([string]$Path)
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { return }
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path "Env:$name" -Value $value
    }
}

function Test-AwsCredentials {
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        Write-Host 'WARNING: aws CLI not found — skipping credential preflight.'
        return
    }

    if ($env:AWS_ACCESS_KEY_ID -like 'ASIA*' -and [string]::IsNullOrWhiteSpace($env:AWS_SESSION_TOKEN)) {
        Write-Host 'ERROR: Temporary AWS credentials detected (ASIA* access key) but AWS_SESSION_TOKEN is missing.'
        Write-Host ''
        Write-Host 'Refresh credentials and update litellm\.env:'
        Write-Host '  aws sso login --profile YOUR_PROFILE'
        Write-Host '  .\refresh-aws-env.ps1 YOUR_PROFILE'
        exit 1
    }

    aws sts get-caller-identity 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: AWS credentials are invalid or expired.'
        Write-Host ''
        if ($env:AWS_PROFILE) {
            Write-Host "Try: aws sso login --profile $env:AWS_PROFILE"
        }
        else {
            Write-Host 'Try: .\refresh-aws-env.ps1 YOUR_PROFILE'
            Write-Host 'Or create new IAM keys in AWS Console -> IAM -> Users -> Security credentials.'
        }
        Write-Host ''
        Write-Host 'Verify with: aws sts get-caller-identity'
        exit 1
    }

    $account = aws sts get-caller-identity --query Account --output text 2>$null
    $arn = aws sts get-caller-identity --query Arn --output text 2>$null
    Write-Host "AWS identity OK: $account ($arn)"
}

if (-not (Test-Path $VenvLiteLLM)) {
    Write-Host 'Virtual env not found. Run from this directory:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File setup.ps1'
    exit 1
}

if (-not (Test-Path $EnvFile)) {
    Write-Host "Missing $EnvFile — copy .env.example and add AWS credentials."
    exit 1
}

Import-DotEnv -Path $EnvFile

# Normalize region env vars (LiteLLM + boto3)
if (-not $env:AWS_REGION) {
    if ($env:AWS_REGION_NAME) { $env:AWS_REGION = $env:AWS_REGION_NAME }
    elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_REGION = $env:AWS_DEFAULT_REGION }
    else { $env:AWS_REGION = 'us-east-1' }
}
if (-not $env:AWS_REGION_NAME) { $env:AWS_REGION_NAME = $env:AWS_REGION }
if (-not $env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION = $env:AWS_REGION }

# Profile mode: use %USERPROFILE%\.aws\credentials for the named profile
if ($env:AWS_PROFILE) {
    Remove-Item Env:AWS_ACCESS_KEY_ID -ErrorAction SilentlyContinue
    Remove-Item Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
}

Test-AwsCredentials

Write-Host 'Starting LiteLLM on http://localhost:4000 ...'
& $VenvLiteLLM --config $ConfigFile --port 4000
