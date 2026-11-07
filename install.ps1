param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginSource = Join-Path $RepoRoot "plugin"
$SkillSource = Join-Path $RepoRoot "skill"
$PluginTarget = Join-Path $DshHome "plugin-sources\dsh-okx-tradingagents"
$SkillTarget = Join-Path $DshHome "skills\okx-tradingagents"
$DataRoot = Join-Path $DshHome "okx-tradingagents"

Write-Host "DSH home: $DshHome"

if (-not (Test-Path $PluginSource)) { throw "plugin/ not found next to install.ps1" }
if (-not (Test-Path (Join-Path $SkillSource "SKILL.md"))) { throw "skill/SKILL.md not found" }

if (Test-Path $PluginTarget) { Remove-Item $PluginTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PluginTarget | Out-Null
Copy-Item (Join-Path $PluginSource "*") $PluginTarget -Recurse -Force

New-Item -ItemType Directory -Force -Path $SkillTarget | Out-Null
Copy-Item (Join-Path $SkillSource "SKILL.md") (Join-Path $SkillTarget "SKILL.md") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "reports") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "paper") | Out-Null

function YamlQuote([string]$value) {
  return "'" + $value.Replace("'", "''") + "'"
}

# DSH Desktop runs its own Electron binary as Node when ELECTRON_RUN_AS_NODE=1.
# Absolute paths are written into the installed copy so the bundle is not tied
# to the repository checkout.
$DshExe = $null
$proc = Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
if ($proc) { $DshExe = $proc.Path }
if (-not $DshExe) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop\DSH Desktop.exe"),
    (Join-Path $env:ProgramFiles "DSH Desktop\DSH Desktop.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "DSH Desktop\DSH Desktop.exe")
  )
  $DshExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $DshExe) {
  throw "Could not locate DSH Desktop.exe. Open DSH, then re-run install.ps1; or edit $PluginTarget\cordis.patch.yml manually."
}

$ServerPath = Join-Path $PluginTarget "server.mjs"
$ReportDir = Join-Path $DataRoot "reports"
$PaperState = Join-Path $DataRoot "paper\account.json"
$Patch = @"
- insert:
    - id: okx-tradingagents-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: okx
        transport: stdio
        command: $(YamlQuote $DshExe)
        args:
          - $(YamlQuote $ServerPath)
        cwd: $(YamlQuote $PluginTarget)
        env:
          ELECTRON_RUN_AS_NODE: '1'
          OKX_REPORT_DIR: $(YamlQuote $ReportDir)
          OKX_PAPER_STATE: $(YamlQuote $PaperState)
          OKX_LIVE_STATE: $(YamlQuote (Join-Path $DataRoot "live\state.json"))
        toolCallTimeoutMs: 180000
        failOnStartupError: true
"@
[IO.File]::WriteAllText((Join-Path $PluginTarget "cordis.patch.yml"), $Patch, [Text.UTF8Encoding]::new($false))

$PresetPatch = Get-Content (Join-Path $PluginTarget "preset.patch.yml") -Raw
[IO.File]::WriteAllText(
  (Join-Path $PluginTarget "cordis.patch.yml"),
  $Patch + "`n" + $PresetPatch,
  [Text.UTF8Encoding]::new($false)
)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warning "node was not found on PATH. The installed patch uses DSH Desktop.exe as Node, so this is normally fine."
}

Write-Host ""
Write-Host "Installed:"
Write-Host "  plugin: $PluginTarget"
Write-Host "  skill:  $SkillTarget"
Write-Host "  data:   $DataRoot"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Open DSH -> Settings -> Plugin Manager -> Install local bundle"
Write-Host "  2. Choose: $PluginTarget"
Write-Host "  3. In chat, run: /okx-tradingagents"
Write-Host ""
Write-Host "No OKX API key is needed for analysis or paper trading."
