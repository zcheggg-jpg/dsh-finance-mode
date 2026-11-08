<#
  set-okx-keys.ps1 - Interactive OKX API key setup (ASCII-only for PS 5.1 safety)

  Usage (PowerShell in this folder):
      powershell -ExecutionPolicy Bypass -File .\set-okx-keys.ps1

  Security notes:
    * Create a READ-ONLY API key in OKX first (no Trade, no Withdraw permission).
    * Bind the key to your public IP whitelist in the OKX dashboard.
    * Only for live trading later: create a separate Trade-only key, never Withdraw.
    * Keys go to USER-level environment variables only, never written to disk in plaintext.
    * You MUST fully quit and restart DeepSeek Harness afterwards, because the MCP
      server child process inherits the environment captured at app startup.

  Remove keys later:
      [Environment]::SetEnvironmentVariable('OKX_API_KEY',$null,'User')
      [Environment]::SetEnvironmentVariable('OKX_API_SECRET',$null,'User')
      [Environment]::SetEnvironmentVariable('OKX_API_PASSPHRASE',$null,'User')
#>

$ErrorActionPreference = 'Stop'

function Read-SecretPlain([string]$Prompt) {
    $sec = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Mask([string]$v) {
    if ([string]::IsNullOrEmpty($v)) { return '(empty)' }
    if ($v.Length -le 8) { return ('*' * $v.Length) }
    return $v.Substring(0, 4) + ('*' * ($v.Length - 8)) + $v.Substring($v.Length - 4)
}

Write-Host '=== OKX key setup (writes USER-level environment variables) ===' -ForegroundColor Cyan

$key    = Read-SecretPlain 'OKX_API_KEY (looks like xxxx-xxxx-xxxx-xxxx)'
$secret = Read-SecretPlain 'OKX_API_SECRET'
$pass   = Read-SecretPlain 'OKX_API_PASSPHRASE (the passphrase you set when creating the key)'

if ([string]::IsNullOrWhiteSpace($key) -or
    [string]::IsNullOrWhiteSpace($secret) -or
    [string]::IsNullOrWhiteSpace($pass)) {
    Write-Host 'One or more fields were empty. Aborted, nothing was written.' -ForegroundColor Red
    exit 1
}

[Environment]::SetEnvironmentVariable('OKX_API_KEY',        $key,    'User')
[Environment]::SetEnvironmentVariable('OKX_API_SECRET',     $secret, 'User')
[Environment]::SetEnvironmentVariable('OKX_API_PASSPHRASE', $pass,   'User')

# Live trading stays disabled by default; enable it separately when you are ready.
$liveFlag = [Environment]::GetEnvironmentVariable('OKX_TRADING_ENABLED', 'User')
if ([string]::IsNullOrEmpty($liveFlag)) {
    [Environment]::SetEnvironmentVariable('OKX_TRADING_ENABLED', '0', 'User')
    $liveFlag = '0'
}

Write-Host ''
Write-Host 'Saved to user environment:' -ForegroundColor Green
Write-Host ('  OKX_API_KEY         = ' + (Mask $key))
Write-Host ('  OKX_API_SECRET      = ' + (Mask $secret))
Write-Host ('  OKX_API_PASSPHRASE  = ' + (Mask $pass))
Write-Host ('  OKX_TRADING_ENABLED = ' + $liveFlag)
Write-Host ''
Write-Host 'Next: fully quit DeepSeek Harness (including tray process) and start it again.' -ForegroundColor Yellow
Write-Host 'Then ask the assistant to verify with okx_account / live_status.' -ForegroundColor Yellow
