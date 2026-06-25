[CmdletBinding()]
param (
    [string]$TargetDir = $null
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    $TargetDir = Split-Path -Parent $PSScriptRoot
}

$TargetDir = (Get-Item -LiteralPath $TargetDir).FullName
$ProfilePath = Join-Path $TargetDir ".agent-scaffold\profile.env"
if (-not (Test-Path -LiteralPath $ProfilePath)) {
    throw "Missing scaffold profile: $ProfilePath"
}

$Profile = @{}
foreach ($Line in Get-Content -LiteralPath $ProfilePath) {
    if ($Line -match "^\s*([^#=]+)=(.*)$") {
        $Profile[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$RepoUrl = $Profile["SOURCE_REPO"]
$SourceRef = $Profile["SOURCE_REF"]
$PackChoice = $Profile["PACK_CHOICE"]
$AdapterChoices = @($Profile["ADAPTER_CHOICES"].Split(",") | Where-Object { $_ })

if (-not $RepoUrl -or -not $SourceRef -or -not $PackChoice -or -not $AdapterChoices.Count) {
    throw "Invalid scaffold profile: $ProfilePath"
}

$TempDir = Join-Path $env:TEMP ("agent-scaffold-update-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))

try {
    Write-Host "Fetching agent-scaffold $SourceRef..." -ForegroundColor Cyan
    & git clone --depth 1 --branch $SourceRef $RepoUrl $TempDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to clone $RepoUrl at ref $SourceRef"
    }

    foreach ($AdapterChoice in $AdapterChoices) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $TempDir "install.ps1") `
            -TargetDir $TargetDir `
            -PackChoice $PackChoice `
            -AdapterChoice $AdapterChoice `
            -Force `
            -SkipHooks
        if ($LASTEXITCODE -ne 0) {
            throw "Scaffold update failed for adapter choice $AdapterChoice"
        }
    }

    $Commit = (& git -C $TempDir rev-parse HEAD).Trim()
    $UpdatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    @(
        "SOURCE_COMMIT=$Commit"
        "UPDATED_AT=$UpdatedAt"
    ) | Set-Content -LiteralPath (Join-Path $TargetDir ".agent-scaffold\last-update.env")

    Write-Host "Scaffold updated successfully." -ForegroundColor Green
    Write-Host "Commit: $Commit"
} finally {
    if (Test-Path -LiteralPath $TempDir) {
        $Resolved = (Resolve-Path -LiteralPath $TempDir).Path
        $TempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path
        if (-not $Resolved.StartsWith($TempRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe temporary cleanup target: $Resolved"
        }
        Remove-Item -LiteralPath $Resolved -Recurse -Force
    }
}
