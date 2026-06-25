[CmdletBinding()]
param (
    [string]$TargetDir = $null,
    [switch]$PullIfChanged = $false,
    [switch]$CheckOnly = $false,
    [switch]$Watch = $false,
    [ValidateRange(5, 86400)]
    [int]$IntervalSeconds = 300
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

function Get-LastInstalledCommit {
    $LastUpdatePath = Join-Path $TargetDir ".agent-scaffold\last-update.env"
    if (-not (Test-Path -LiteralPath $LastUpdatePath)) {
        return $null
    }

    foreach ($Line in Get-Content -LiteralPath $LastUpdatePath) {
        if ($Line -match "^SOURCE_COMMIT=(.+)$") {
            return $Matches[1].Trim()
        }
    }

    return $null
}

function Get-RemoteCommit {
    $RemoteLine = (& git ls-remote $RepoUrl $SourceRef | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to query remote ref $SourceRef from $RepoUrl"
    }
    if ([string]::IsNullOrWhiteSpace($RemoteLine)) {
        throw "Remote ref not found: $SourceRef"
    }

    return ($RemoteLine -split "\s+")[0].Trim()
}

function Invoke-ScaffoldUpdate {
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
        return $Commit
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
}

function Get-UpdateStatus {
    $InstalledCommit = Get-LastInstalledCommit
    $RemoteCommit = Get-RemoteCommit
    $NeedsUpdate = $InstalledCommit -ne $RemoteCommit

    return [pscustomobject]@{
        TargetDir = $TargetDir
        SourceRef = $SourceRef
        InstalledCommit = $InstalledCommit
        RemoteCommit = $RemoteCommit
        NeedsUpdate = $NeedsUpdate
    }
}

if ($CheckOnly) {
    $Status = Get-UpdateStatus
    $Status | ConvertTo-Json
    if ($Status.NeedsUpdate) {
        exit 10
    }
    exit 0
}

if ($Watch) {
    Write-Host "Watching $RepoUrl ($SourceRef) every $IntervalSeconds seconds..." -ForegroundColor Cyan
    while ($true) {
        $Status = Get-UpdateStatus
        $Status | ConvertTo-Json
        if ($Status.NeedsUpdate) {
            Invoke-ScaffoldUpdate | Out-Null
        } else {
            Write-Host "No scaffold changes detected." -ForegroundColor DarkGray
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}

if ($PullIfChanged) {
    $Status = Get-UpdateStatus
    $Status | ConvertTo-Json
    if (-not $Status.NeedsUpdate) {
        Write-Host "Scaffold is already up to date." -ForegroundColor Green
        exit 0
    }
    Invoke-ScaffoldUpdate | Out-Null
    exit 0
}

Invoke-ScaffoldUpdate | Out-Null
