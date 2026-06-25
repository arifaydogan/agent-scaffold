[CmdletBinding()]
param (
    [Parameter(Position = 0)]
    [string]$TargetDir = $null,

    [Parameter(Position = 1)]
    [string]$PackChoice = $null,

    [Parameter(Position = 2)]
    [string]$AdapterChoice = $null,

    [switch]$Force = $false,

    [switch]$WithUpstreamSkills = $false,

    [switch]$WithCaveman = $false,

    [switch]$SkipHooks = $false
)

$RepoUrl = "https://github.com/arifaydogan/agent-scaffold.git"

function Resolve-TargetDirectoryPath {
    param (
        [Parameter(Mandatory = $true)]
        [string]$PathValue
    )

    $Candidate = [Environment]::ExpandEnvironmentVariables($PathValue.Trim().Trim('"'))
    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        $Candidate = (Get-Location).Path
    }

    if (Test-Path -LiteralPath $Candidate) {
        $Item = Get-Item -LiteralPath $Candidate -ErrorAction Stop
        if (-not $Item.PSIsContainer) {
            throw "Target path is not a directory: $Candidate"
        }
        return [string]$Item.FullName
    }

    $Created = New-Item -ItemType Directory -Path $Candidate -Force -ErrorAction Stop
    return [string]$Created.FullName
}

# Define cleanup block
$Cleanup = {
    if ($TempDir -and (Test-Path $TempDir)) {
        Write-Host "Cleaning up temporary directory..." -ForegroundColor Yellow
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host "        AI Team Scaffold Installer           " -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan

    # Detect source directory from the script location, not the caller's cwd.
    $ScriptDir = $PSScriptRoot
    $HasScriptSource = $ScriptDir -and
        (Test-Path -LiteralPath (Join-Path $ScriptDir "core")) -and
        (Test-Path -LiteralPath (Join-Path $ScriptDir "packs"))
    if ($HasScriptSource) {
        $SourceDir = $ScriptDir
        Write-Host "Using local source directory: $SourceDir" -ForegroundColor Green
        $TempDir = $null
    } else {
        # Remote execution: Clone repository to temp directory
        $TempDir = Join-Path $env:TEMP ("agent-scaffold-" + [Guid]::NewGuid().ToString().Substring(0,8))
        Write-Host "Cloning scaffold repository from $RepoUrl to temporary directory..." -ForegroundColor Yellow
        
        # Run git clone
        & git clone --depth 1 $RepoUrl $TempDir | Out-Null
        if (-not $?) {
            Write-Error "Failed to clone repository from $RepoUrl"
            exit 1
        }
        $SourceDir = $TempDir
    }

# Interactive Inputs
$Interactive = $false
if (-not $TargetDir -or -not $PackChoice -or -not $AdapterChoice) {
    $Interactive = $true
}

if ($Interactive) {
    $TargetInput = Read-Host "Enter target project directory (default: .)"
    $TargetDir = Resolve-TargetDirectoryPath $TargetInput
} else {
    $TargetDir = Resolve-TargetDirectoryPath $TargetDir
}

if ([string]::IsNullOrWhiteSpace([string]$TargetDir)) {
    throw "Target directory could not be resolved."
}

if ($Interactive) {
    Write-Host "`nSelect Pack Option:"
    Write-Host "  1) Core (Standard 9 Agents & Rules)"
    Write-Host "  2) Core + PaceBuild (10 Agents, Overrides & Context)"
    while ($true) {
        $PackInput = Read-Host "Choice (1-2)"
        if ($PackInput -eq "1" -or $PackInput -eq "2") {
            $PackChoice = $PackInput
            break
        }
        Write-Host "Invalid choice. Please select 1 or 2." -ForegroundColor Red
    }
}

if ($Interactive) {
    Write-Host "`nSelect Target Adapter(s):"
    Write-Host "  1) Antigravity (.agents/ structure)"
    Write-Host "  2) Claude Code (CLAUDE.md & .claude/ structure)"
    Write-Host "  3) GitHub Copilot (.github/copilot-instructions.md)"
    Write-Host "  4) Codex (AGENTS.md & .codex/ structure)"
    Write-Host "  5) All Adapters"
    while ($true) {
        $AdapterInput = Read-Host "Choice (1-5)"
        if ($AdapterInput -match "^[1-5]$") {
            $AdapterChoice = $AdapterInput
            break
        }
        Write-Host "Invalid choice. Please select 1, 2, 3, 4 or 5." -ForegroundColor Red
    }
}

$PackName = if ($PackChoice -eq "1") { "Core Only" } else { "Core + PaceBuild" }
$AdapterName = switch ($AdapterChoice) {
    "1" { "Antigravity" }
    "2" { "Claude Code" }
    "3" { "Copilot" }
    "4" { "Codex" }
    "5" { "All Adapters" }
}

Write-Host "`nConfiguration Summary:"
Write-Host "  - Source: $SourceDir"
Write-Host "  - Target: $TargetDir"
Write-Host "  - Pack:   $PackName"
Write-Host "  - Adapter:$AdapterName"

# Check for existing installations
$ExistingFiles = @()
if (Test-Path (Join-Path $TargetDir "ORCHESTRATION.md")) { $ExistingFiles += "ORCHESTRATION.md" }
if (Test-Path (Join-Path $TargetDir "PACEBUILD_ORCHESTRATOR.md")) { $ExistingFiles += "PACEBUILD_ORCHESTRATOR.md" }
if ($AdapterChoice -eq "1" -or $AdapterChoice -eq "5") {
    if (Test-Path (Join-Path $TargetDir ".agents")) { $ExistingFiles += ".agents\" }
}
if ($AdapterChoice -eq "2" -or $AdapterChoice -eq "5") {
    if (Test-Path (Join-Path $TargetDir "CLAUDE.md")) { $ExistingFiles += "CLAUDE.md" }
    if (Test-Path (Join-Path $TargetDir ".claude")) { $ExistingFiles += ".claude\" }
}
if ($AdapterChoice -eq "3" -or $AdapterChoice -eq "5") {
    if (Test-Path (Join-Path $TargetDir ".github\copilot-instructions.md")) { $ExistingFiles += ".github\copilot-instructions.md" }
}
if ($AdapterChoice -eq "4" -or $AdapterChoice -eq "5") {
    if (Test-Path (Join-Path $TargetDir "AGENTS.md")) { $ExistingFiles += "AGENTS.md" }
    if (Test-Path (Join-Path $TargetDir ".codex")) { $ExistingFiles += ".codex\" }
}

if ($ExistingFiles.Count -gt 0 -and -not $Force) {
    Write-Host "WARNING: The following existing folders/files will be overwritten:" -ForegroundColor Yellow
    foreach ($f in $ExistingFiles) {
        Write-Host "  - $f" -ForegroundColor Yellow
    }
    if ($Interactive) {
        $Confirm = Read-Host "Do you want to proceed and overwrite? (y/N)"
        if ($Confirm -notmatch "^[yY](es)?$") {
            Write-Host "Installation cancelled." -ForegroundColor Red
            & $Cleanup
            exit 0
        }
    } else {
        Write-Error "Target files already exist and -Force was not specified. Aborting."
        & $Cleanup
        exit 1
    }
}

# The orchestration contracts are shared by every adapter.
Copy-Item -Path (Join-Path $SourceDir "ORCHESTRATION.md") -Destination (Join-Path $TargetDir "ORCHESTRATION.md") -Force
Copy-Item -Path (Join-Path $SourceDir "PACEBUILD_ORCHESTRATOR.md") -Destination (Join-Path $TargetDir "PACEBUILD_ORCHESTRATOR.md") -Force

# Helpers for file copying
function Copy-RulesAntigravity {
    param ($src, $dest)
    $rulesDest = Join-Path $dest "rules"
    New-Item -ItemType Directory -Path $rulesDest -Force | Out-Null
    Copy-Item -Path (Join-Path $src "core\rules\*.md") -Destination $rulesDest -Force
    
    if ($PackChoice -eq "2") {
        Copy-Item -Path (Join-Path $src "packs\pacebuild\overrides\rules\demo-reliability-guard.md") -Destination $rulesDest -Force
        Copy-Item -Path (Join-Path $src "packs\pacebuild\context\jira-protocol.md") -Destination (Join-Path $rulesDest "jira-protocol.md") -Force
    }
}

function Copy-SkillsAntigravity {
    param ($src, $dest)
    $skillsDest = Join-Path $dest "skills"
    New-Item -ItemType Directory -Path $skillsDest -Force | Out-Null
    
    # Copy core skills
    $coreAgents = Get-ChildItem -Path (Join-Path $src "core\agents") -Directory
    foreach ($agent in $coreAgents) {
        $skillsPath = Join-Path $agent.FullName "skills"
        if (Test-Path $skillsPath) {
            $skills = Get-ChildItem -Path $skillsPath -Directory
            foreach ($skill in $skills) {
                $skillTarget = Join-Path $skillsDest $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
    }
    
    # Copy PaceBuild specific skills & overrides
    if ($PackChoice -eq "2") {
        $cvSkillsPath = Join-Path $src "packs\pacebuild\agents\cv-engineer\skills"
        if (Test-Path $cvSkillsPath) {
            $cvSkills = Get-ChildItem -Path $cvSkillsPath -Directory
            foreach ($skill in $cvSkills) {
                $skillTarget = Join-Path $skillsDest $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
        
        $beOverridePath = Join-Path $src "packs\pacebuild\overrides\backend-engineer\skills\fastapi-timescale"
        if (Test-Path $beOverridePath) {
            $skillTarget = Join-Path $skillsDest "fastapi-timescale"
            New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
            Copy-Item -Path (Join-Path $beOverridePath "*") -Destination $skillTarget -Recurse -Force
        }
    }
}

function Copy-AgentsAntigravity {
    param ($src, $dest)
    $agentsDest = Join-Path $dest "agents"
    $personasDest = Join-Path $dest "personas"
    New-Item -ItemType Directory -Path $agentsDest -Force | Out-Null
    New-Item -ItemType Directory -Path $personasDest -Force | Out-Null
    
    # Copy core agents
    Copy-Item -Path (Join-Path $src "core\agents\*") -Destination $agentsDest -Recurse -Force
    Copy-Item -Path (Join-Path $src "core\personas\*") -Destination $personasDest -Recurse -Force
    Copy-Item -Path (Join-Path $src "AGENTS.md") -Destination (Join-Path $dest "AGENTS.md") -Force
    Copy-Item -Path (Join-Path $src "ORCHESTRATION.md") -Destination (Join-Path $dest "ORCHESTRATION.md") -Force
    
    # Copy PaceBuild agents and overrides
    if ($PackChoice -eq "2") {
        $cvDest = Join-Path $agentsDest "cv-engineer"
        New-Item -ItemType Directory -Path $cvDest -Force | Out-Null
        Copy-Item -Path (Join-Path $src "packs\pacebuild\agents\cv-engineer\*") -Destination $cvDest -Recurse -Force
        Copy-Item -Path (Join-Path $src "packs\pacebuild\overrides\AGENTS.md") -Destination (Join-Path $dest "AGENTS.md") -Force
    }
}

# ----------------------------------------------------
# 1) Install Antigravity Adapter
# ----------------------------------------------------
if ($AdapterChoice -eq "1" -or $AdapterChoice -eq "5") {
    Write-Host "Installing Antigravity Adapter..."
    $agentsDir = Join-Path $TargetDir ".agents"
    New-Item -ItemType Directory -Path $agentsDir -Force | Out-Null
    Copy-RulesAntigravity $SourceDir $agentsDir
    Copy-SkillsAntigravity $SourceDir $agentsDir
    Copy-AgentsAntigravity $SourceDir $agentsDir
    $orchestratorSkill = Join-Path $agentsDir "skills\pacebuild-orchestrator"
    New-Item -ItemType Directory -Path $orchestratorSkill -Force | Out-Null
    Copy-Item -Path (Join-Path $SourceDir "adapters\antigravity\pacebuild-orchestrator\SKILL.md") -Destination (Join-Path $orchestratorSkill "SKILL.md") -Force
    Copy-Item -Path (Join-Path $SourceDir "adapters\antigravity\orchestration-gates.md") -Destination (Join-Path $agentsDir "rules\orchestration-gates.md") -Force
    Write-Host "Antigravity Adapter installed successfully." -ForegroundColor Green
}

# ----------------------------------------------------
# 2) Install Claude Code Adapter
# ----------------------------------------------------
if ($AdapterChoice -eq "2" -or $AdapterChoice -eq "5") {
    Write-Host "Installing Claude Code Adapter..."
    $claudeDir = Join-Path $TargetDir ".claude"
    $claudeAgents = Join-Path $claudeDir "agents"
    $claudeSkills = Join-Path $claudeDir "skills"
    $claudePersonas = Join-Path $claudeDir "personas"
    New-Item -ItemType Directory -Path $claudeAgents -Force | Out-Null
    New-Item -ItemType Directory -Path $claudeSkills -Force | Out-Null
    New-Item -ItemType Directory -Path $claudePersonas -Force | Out-Null
    
    # Copy core agents
    Copy-Item -Path (Join-Path $SourceDir "core\agents\*") -Destination $claudeAgents -Recurse -Force
    Copy-Item -Path (Join-Path $SourceDir "core\personas\*") -Destination $claudePersonas -Recurse -Force
    
    # Copy core skills
    $coreAgents = Get-ChildItem -Path (Join-Path $SourceDir "core\agents") -Directory
    foreach ($agent in $coreAgents) {
        $skillsPath = Join-Path $agent.FullName "skills"
        if (Test-Path $skillsPath) {
            $skills = Get-ChildItem -Path $skillsPath -Directory
            foreach ($skill in $skills) {
                $skillTarget = Join-Path $claudeSkills $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
    }
    
    # PaceBuild modifications
    if ($PackChoice -eq "2") {
        $cvDest = Join-Path $claudeAgents "cv-engineer"
        New-Item -ItemType Directory -Path $cvDest -Force | Out-Null
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\*") -Destination $cvDest -Recurse -Force
        
        $cvSkillsPath = Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\skills"
        if (Test-Path $cvSkillsPath) {
            $cvSkills = Get-ChildItem -Path $cvSkillsPath -Directory
            foreach ($skill in $cvSkills) {
                $skillTarget = Join-Path $claudeSkills $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
        
        $beOverridePath = Join-Path $SourceDir "packs\pacebuild\overrides\backend-engineer\skills\fastapi-timescale"
        if (Test-Path $beOverridePath) {
            $skillTarget = Join-Path $claudeSkills "fastapi-timescale"
            New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
            Copy-Item -Path (Join-Path $beOverridePath "*") -Destination $skillTarget -Recurse -Force
        }
    }
    
    # Generate CLAUDE.md
    $claudeMdPath = Join-Path $TargetDir "CLAUDE.md"
    $claudeMdContent = @(
        "# Claude Code System Guidelines",
        "",
        "## Orchestration Protocol"
    )
    $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "ORCHESTRATION.md") -Raw
    $claudeMdContent += ""
    $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "core\rules\global.md") -Raw
    $claudeMdContent += ""
    $claudeMdContent += "## Git & Branching Policy"
    $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "core\rules\git-workflow.md") -Raw
    
    if ($PackChoice -eq "2") {
        $claudeMdContent += ""
        $claudeMdContent += "## PaceBuild Reliability Rules"
        $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "packs\pacebuild\overrides\rules\demo-reliability-guard.md") -Raw
        $claudeMdContent += ""
        $claudeMdContent += "## Jira Protocol Context"
        $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "packs\pacebuild\context\jira-protocol.md") -Raw
    } else {
        $claudeMdContent += ""
        $claudeMdContent += "## Jira Protocol"
        $claudeMdContent += Get-Content -Path (Join-Path $SourceDir "core\rules\jira-protocol.md") -Raw
    }
    
    $claudeMdContent | Set-Content -Path $claudeMdPath -Force
    Write-Host "Claude Code Adapter installed successfully." -ForegroundColor Green
}

# ----------------------------------------------------
# 3) Install Copilot Adapter
# ----------------------------------------------------
if ($AdapterChoice -eq "3" -or $AdapterChoice -eq "5") {
    Write-Host "Installing GitHub Copilot Adapter..."
    $githubDir = Join-Path $TargetDir ".github"
    $copilotAgentsDir = Join-Path $githubDir "agents"
    $copilotSkillsDir = Join-Path $githubDir "skills"
    $copilotPersonasDir = Join-Path $githubDir "personas"
    $copilotTaskAgentsDir = Join-Path $githubDir "task-agents"
    $vscodeDir = Join-Path $TargetDir ".vscode"
    New-Item -ItemType Directory -Path $githubDir -Force | Out-Null
    New-Item -ItemType Directory -Path $copilotAgentsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $copilotSkillsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $copilotPersonasDir -Force | Out-Null
    New-Item -ItemType Directory -Path $copilotTaskAgentsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null

    Copy-Item -Path (Join-Path $SourceDir "core\personas\*") -Destination $copilotPersonasDir -Recurse -Force
    foreach ($agent in Get-ChildItem -Path (Join-Path $SourceDir "core\agents") -Directory) {
        $agentTarget = Join-Path $copilotTaskAgentsDir $agent.Name
        New-Item -ItemType Directory -Path $agentTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $agent.FullName "AGENT.md") -Destination (Join-Path $agentTarget "AGENT.md") -Force
    }
    Copy-Item -Path (Join-Path $SourceDir "adapters\pacebuild-orchestrator.agent.md") -Destination (Join-Path $copilotAgentsDir "pacebuild-orchestrator.agent.md") -Force
    Copy-Item -Path (Join-Path $SourceDir "adapters\copilot-mcp.example.json") -Destination (Join-Path $vscodeDir "mcp.example.json") -Force

    $coreAgents = Get-ChildItem -Path (Join-Path $SourceDir "core\agents") -Directory
    foreach ($agent in $coreAgents) {
        $skillsPath = Join-Path $agent.FullName "skills"
        if (Test-Path $skillsPath) {
            foreach ($skill in Get-ChildItem -Path $skillsPath -Directory) {
                $skillTarget = Join-Path $copilotSkillsDir $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
    }

    if ($PackChoice -eq "2") {
        $cvAgentTarget = Join-Path $copilotTaskAgentsDir "cv-engineer"
        New-Item -ItemType Directory -Path $cvAgentTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\AGENT.md") -Destination (Join-Path $cvAgentTarget "AGENT.md") -Force
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\rules.md") -Destination (Join-Path $cvAgentTarget "rules.md") -Force
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\overrides\AGENTS.md") -Destination (Join-Path $copilotTaskAgentsDir "AGENTS.md") -Force

        $cvSkillsPath = Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\skills"
        foreach ($skill in Get-ChildItem -Path $cvSkillsPath -Directory) {
            $skillTarget = Join-Path $copilotSkillsDir $skill.Name
            New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
            Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
        }

        $fastApiTimescale = Join-Path $SourceDir "packs\pacebuild\overrides\backend-engineer\skills\fastapi-timescale"
        $fastApiTimescaleTarget = Join-Path $copilotSkillsDir "fastapi-timescale"
        New-Item -ItemType Directory -Path $fastApiTimescaleTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $fastApiTimescale "*") -Destination $fastApiTimescaleTarget -Recurse -Force
    } else {
        Copy-Item -Path (Join-Path $SourceDir "AGENTS.md") -Destination (Join-Path $copilotTaskAgentsDir "AGENTS.md") -Force
    }
    
    $copilotInstructionsPath = Join-Path $githubDir "copilot-instructions.md"
    $copilotContent = @(
        "# GitHub Copilot Custom Instructions",
        "",
        "## Orchestration Protocol"
    )
    $copilotContent += Get-Content -Path (Join-Path $SourceDir "ORCHESTRATION.md") -Raw
    $copilotContent += ""
    $copilotContent += Get-Content -Path (Join-Path $SourceDir "core\rules\global.md") -Raw
    $copilotContent += ""
    
    if ($PackChoice -eq "2") {
        $copilotContent += "## PaceBuild Reliability Guard"
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "packs\pacebuild\overrides\rules\demo-reliability-guard.md") -Raw
        $copilotContent += ""
        $copilotContent += "## PaceBuild Jira Protocol"
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "packs\pacebuild\context\jira-protocol.md") -Raw
        $copilotContent += ""
        $copilotContent += "## Agent Routing Matrix (PaceBuild)"
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "packs\pacebuild\overrides\AGENTS.md") -Raw
    } else {
        $copilotContent += "## Git & Jira Guidelines"
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "core\rules\git-workflow.md") -Raw
        $copilotContent += ""
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "core\rules\jira-protocol.md") -Raw
        $copilotContent += ""
        $copilotContent += "## Agent Routing Matrix"
        $copilotContent += Get-Content -Path (Join-Path $SourceDir "AGENTS.md") -Raw
    }
    
    $copilotContent | Set-Content -Path $copilotInstructionsPath -Force
    Write-Host "GitHub Copilot Adapter installed successfully." -ForegroundColor Green
}

# ----------------------------------------------------
# 4) Install Codex Adapter
# ----------------------------------------------------
if ($AdapterChoice -eq "4" -or $AdapterChoice -eq "5") {
    Write-Host "Installing Codex Adapter..."
    $codexDir = Join-Path $TargetDir ".codex"
    $codexAgentsDir = Join-Path $codexDir "agents"
    $codexSkillsDir = Join-Path $codexDir "skills"
    $codexPersonasDir = Join-Path $codexDir "personas"
    $codexRulesDir = Join-Path $codexDir "rules"
    New-Item -ItemType Directory -Path $codexAgentsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $codexSkillsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $codexPersonasDir -Force | Out-Null
    New-Item -ItemType Directory -Path $codexRulesDir -Force | Out-Null

    Copy-Item -Path (Join-Path $SourceDir "core\agents\*") -Destination $codexAgentsDir -Recurse -Force
    Copy-Item -Path (Join-Path $SourceDir "core\personas\*") -Destination $codexPersonasDir -Recurse -Force
    Copy-Item -Path (Join-Path $SourceDir "core\rules\*.md") -Destination $codexRulesDir -Force
    $codexOrchestratorSkill = Join-Path $codexSkillsDir "pacebuild-orchestrator"
    New-Item -ItemType Directory -Path $codexOrchestratorSkill -Force | Out-Null
    Copy-Item -Path (Join-Path $SourceDir "adapters\codex\pacebuild-orchestrator\SKILL.md") -Destination (Join-Path $codexOrchestratorSkill "SKILL.md") -Force

    $coreAgents = Get-ChildItem -Path (Join-Path $SourceDir "core\agents") -Directory
    foreach ($agent in $coreAgents) {
        $skillsPath = Join-Path $agent.FullName "skills"
        if (Test-Path $skillsPath) {
            foreach ($skill in Get-ChildItem -Path $skillsPath -Directory) {
                $skillTarget = Join-Path $codexSkillsDir $skill.Name
                New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
                Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
            }
        }
    }

    if ($PackChoice -eq "2") {
        $cvAgentTarget = Join-Path $codexAgentsDir "cv-engineer"
        New-Item -ItemType Directory -Path $cvAgentTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\*") -Destination $cvAgentTarget -Recurse -Force

        $cvSkillsPath = Join-Path $SourceDir "packs\pacebuild\agents\cv-engineer\skills"
        foreach ($skill in Get-ChildItem -Path $cvSkillsPath -Directory) {
            $skillTarget = Join-Path $codexSkillsDir $skill.Name
            New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
            Copy-Item -Path (Join-Path $skill.FullName "*") -Destination $skillTarget -Recurse -Force
        }

        $fastApiTimescale = Join-Path $SourceDir "packs\pacebuild\overrides\backend-engineer\skills\fastapi-timescale"
        $fastApiTimescaleTarget = Join-Path $codexSkillsDir "fastapi-timescale"
        New-Item -ItemType Directory -Path $fastApiTimescaleTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $fastApiTimescale "*") -Destination $fastApiTimescaleTarget -Recurse -Force
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\overrides\rules\demo-reliability-guard.md") -Destination $codexRulesDir -Force
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\context\jira-protocol.md") -Destination (Join-Path $codexRulesDir "jira-protocol.md") -Force
        Copy-Item -Path (Join-Path $SourceDir "packs\pacebuild\overrides\AGENTS.md") -Destination (Join-Path $TargetDir "AGENTS.md") -Force
    } else {
        Copy-Item -Path (Join-Path $SourceDir "AGENTS.md") -Destination (Join-Path $TargetDir "AGENTS.md") -Force
    }

    Copy-Item -Path (Join-Path $SourceDir "ORCHESTRATION.md") -Destination (Join-Path $TargetDir "ORCHESTRATION.md") -Force
    Copy-Item -Path (Join-Path $SourceDir "PACEBUILD_ORCHESTRATOR.md") -Destination (Join-Path $TargetDir "PACEBUILD_ORCHESTRATOR.md") -Force
    @(
        "# Codex Adapter Layout",
        "",
        "- `AGENTS.md`: repository-root instructions Codex reads first.",
        "- `ORCHESTRATION.md`: canonical phase and handoff protocol.",
        "- `PACEBUILD_ORCHESTRATOR.md`: provider-neutral Jira execution contract.",
        "- `.codex/personas/`: decision personas for the active phase.",
        "- `.codex/agents/`: scoped task-agent definitions.",
        "- `.codex/skills/`: reusable skill workflows with scripts and references.",
        "- `.codex/rules/`: global and pack-specific operating rules.",
        "",
        "For Jira work, start from `AGENTS.md`, load `PACEBUILD_ORCHESTRATOR.md`, then load only the persona, task agent, and skills needed for the current phase."
    ) | Set-Content -Path (Join-Path $codexDir "README.md") -Force

    Write-Host "Codex Adapter installed successfully." -ForegroundColor Green
}

# ----------------------------------------------------
# Git Hooks Installation (if target is a Git repo)
# ----------------------------------------------------
if ((Test-Path (Join-Path $TargetDir ".git")) -and -not $SkipHooks) {
    $InstallHooks = $false
    if ($Interactive) {
        $HookConfirm = Read-Host "Git repository detected. Install Git hooks? (Y/n)"
        if ($HookConfirm -notmatch "^[nN](o)?$") {
            $InstallHooks = $true
        }
    } else {
        $InstallHooks = $true
    }
    
    if ($InstallHooks) {
        Write-Host "Installing Git hooks..."
        $hooksDir = Join-Path $TargetDir ".git\hooks"
        New-Item -ItemType Directory -Path $hooksDir -Force | Out-Null
        Copy-Item -Path (Join-Path $SourceDir "hooks\pre-commit") -Destination $hooksDir -Force
        Copy-Item -Path (Join-Path $SourceDir "hooks\commit-msg") -Destination $hooksDir -Force
        Copy-Item -Path (Join-Path $SourceDir "hooks\pre-push") -Destination $hooksDir -Force
        Write-Host "Git hooks installed." -ForegroundColor Green
    }
}


    # === alirezarezvani/claude-skills ===
    $Alireza = "h"
    if ($Interactive) {
        Write-Host ""
        Write-Host "Bundled upstream skill'ler en son alirezarezvani/claude-skills surumunden yenilensin mi?" -ForegroundColor Cyan
        Write-Host "  (Normal kurulumda repo icindeki tam kopyalar zaten kurulur.)" -ForegroundColor Cyan
        $Alireza = Read-Host "[e/h]"
    } else {
        if ($WithUpstreamSkills) { $Alireza = "e" }
    }

    if ($Alireza -eq "e") {
        $SkillsHome = Join-Path $HOME "claude-skills"
        if (Test-Path $SkillsHome) {
            $SkillsSrc = $SkillsHome
            Write-Host "  [OK] Local klon bulundu: $SkillsSrc" -ForegroundColor Green
        } else {
            Write-Host "  [INFO] Klonlaniyor..." -ForegroundColor Yellow
            & git clone --depth 1 https://github.com/alirezarezvani/claude-skills.git $SkillsHome | Out-Null
            if ($?) {
                $SkillsSrc = $SkillsHome
            } else {
                Write-Host "  [WARN] Klonlama basarisiz oldu. Git yuklu mu?" -ForegroundColor Red
                $SkillsSrc = $null
            }
        }

        if ($SkillsSrc) {
            # Core engineer skill'leri
            $RoleMaps = @(
                "architect:engineering-team/skills/senior-architect",
                "backend-engineer:engineering-team/skills/senior-backend",
                "frontend-engineer:engineering-team/skills/senior-frontend",
                "devops-engineer:engineering-team/skills/senior-devops",
                "qa-engineer:engineering-team/skills/tdd-guide",
                "security-engineer:engineering-team/skills/security-pen-testing",
                "data-engineer:engineering-team/skills/senior-data-engineer"
            )

            foreach ($roleMap in $RoleMaps) {
                $parts = $roleMap -split ":"
                $role = $parts[0]
                $srcSub = $parts[1]
                $skillName = Split-Path $srcSub -Leaf
                $srcPath = Join-Path $SkillsSrc $srcSub

                if (Test-Path $srcPath) {
                    # 1. Copy to core/agents/ in target project
                    $destCore = Join-Path $TargetDir "core\agents\$role\skills\$skillName"
                    New-Item -ItemType Directory -Path $destCore -Force | Out-Null
                    Copy-Item -Path (Join-Path $srcPath "*") -Destination $destCore -Recurse -Force | Out-Null
                    Write-Host "  [OK] core/agents/$role -> $skillName" -ForegroundColor Green

                    # 2. Copy to Antigravity adapter (.agents/) if installed
                    if ($AdapterChoice -eq "1" -or $AdapterChoice -eq "5") {
                        $destAnti = Join-Path $TargetDir ".agents\skills\$skillName"
                        New-Item -ItemType Directory -Path $destAnti -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destAnti -Recurse -Force | Out-Null
                    }

                    # 3. Copy to Claude Code adapter (.claude/) if installed
                    if ($AdapterChoice -eq "2" -or $AdapterChoice -eq "5") {
                        $destClaude = Join-Path $TargetDir ".claude\skills\$skillName"
                        New-Item -ItemType Directory -Path $destClaude -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destClaude -Recurse -Force | Out-Null
                    }
                    if ($AdapterChoice -eq "4" -or $AdapterChoice -eq "5") {
                        $destCodex = Join-Path $TargetDir ".codex\skills\$skillName"
                        New-Item -ItemType Directory -Path $destCodex -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destCodex -Recurse -Force | Out-Null
                    }
                } else {
                    Write-Host "  [WARN] $srcSub bulunamadi, atlandi" -ForegroundColor Yellow
                }
            }

            # PM skill'leri
            $PmSkills = @("senior-pm", "confluence-expert", "jira-expert")
            foreach ($pmSkill in $PmSkills) {
                $srcPath = Join-Path $SkillsSrc "project-management\skills\$pmSkill"
                if (Test-Path $srcPath) {
                    # 1. Copy to core/agents/
                    $destCore = Join-Path $TargetDir "core\agents\pm-analyst\skills\$pmSkill"
                    New-Item -ItemType Directory -Path $destCore -Force | Out-Null
                    Copy-Item -Path (Join-Path $srcPath "*") -Destination $destCore -Recurse -Force | Out-Null
                    Write-Host "  [OK] pm-analyst -> $pmSkill" -ForegroundColor Green

                    # 2. Copy to Antigravity adapter
                    if ($AdapterChoice -eq "1" -or $AdapterChoice -eq "5") {
                        $destAnti = Join-Path $TargetDir ".agents\skills\$pmSkill"
                        New-Item -ItemType Directory -Path $destAnti -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destAnti -Recurse -Force | Out-Null
                    }

                    # 3. Copy to Claude Code adapter
                    if ($AdapterChoice -eq "2" -or $AdapterChoice -eq "5") {
                        $destClaude = Join-Path $TargetDir ".claude\skills\$pmSkill"
                        New-Item -ItemType Directory -Path $destClaude -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destClaude -Recurse -Force | Out-Null
                    }
                    if ($AdapterChoice -eq "4" -or $AdapterChoice -eq "5") {
                        $destCodex = Join-Path $TargetDir ".codex\skills\$pmSkill"
                        New-Item -ItemType Directory -Path $destCodex -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destCodex -Recurse -Force | Out-Null
                    }
                } else {
                    Write-Host "  [WARN] $pmSkill atlandi" -ForegroundColor Yellow
                }
            }

            # PaceBuild pack: CV Engineer → senior-computer-vision
            if ($PackChoice -eq "2") {
                $srcPath = Join-Path $SkillsSrc "engineering-team\skills\senior-computer-vision"
                if (Test-Path $srcPath) {
                    # 1. Copy to packs/
                    $destPack = Join-Path $TargetDir "packs\pacebuild\agents\cv-engineer\skills\senior-computer-vision"
                    New-Item -ItemType Directory -Path $destPack -Force | Out-Null
                    Copy-Item -Path (Join-Path $srcPath "*") -Destination $destPack -Recurse -Force | Out-Null
                    Write-Host "  [OK] cv-engineer -> senior-computer-vision" -ForegroundColor Green

                    # 2. Copy to Antigravity adapter
                    if ($AdapterChoice -eq "1" -or $AdapterChoice -eq "5") {
                        $destAnti = Join-Path $TargetDir ".agents\skills\senior-computer-vision"
                        New-Item -ItemType Directory -Path $destAnti -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destAnti -Recurse -Force | Out-Null
                    }

                    # 3. Copy to Claude Code adapter
                    if ($AdapterChoice -eq "2" -or $AdapterChoice -eq "5") {
                        $destClaude = Join-Path $TargetDir ".claude\skills\senior-computer-vision"
                        New-Item -ItemType Directory -Path $destClaude -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destClaude -Recurse -Force | Out-Null
                    }
                    if ($AdapterChoice -eq "4" -or $AdapterChoice -eq "5") {
                        $destCodex = Join-Path $TargetDir ".codex\skills\senior-computer-vision"
                        New-Item -ItemType Directory -Path $destCodex -Force | Out-Null
                        Copy-Item -Path (Join-Path $srcPath "*") -Destination $destCodex -Recurse -Force | Out-Null
                    }
                } else {
                    Write-Host "  [WARN] senior-computer-vision atlandi" -ForegroundColor Yellow
                }
            }

            Write-Host "  [OK] alirezarezvani skill'leri kuruldu" -ForegroundColor Green
        }
    }

    # === Caveman — token tasarrufu ===
    $Caveman = "h"
    if ($Interactive) {
        Write-Host ""
        Write-Host "Caveman kurulsun mu? (Opus gibi pahalı modellerde ~%65 output token azalması)" -ForegroundColor Cyan
        $Caveman = Read-Host "[e/h]"
    } else {
        if ($WithCaveman) { $Caveman = "e" }
    }

    if ($Caveman -eq "e") {
        Write-Host "  [INFO] Caveman kuruluyor..." -ForegroundColor Yellow
        Push-Location $TargetDir
        try {
            & npx -y github:JuliusBrussee/caveman -- --with-init
            if ($?) {
                Write-Host "  [OK] Caveman kuruldu" -ForegroundColor Green
            } else {
                Write-Host "  [WARN] Caveman kurulumu basarisiz (node ve git gereklidir)" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  [WARN] Caveman kurulumu sirasinda bir hata olustu: $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            Pop-Location
        }
    }

    # Persist the local installation profile for one-command updates.
    $ProfileDir = Join-Path $TargetDir ".agent-scaffold"
    $ProfilePath = Join-Path $ProfileDir "profile.env"
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null

    $InstalledAdapters = @()
    if (Test-Path -LiteralPath $ProfilePath) {
        foreach ($Line in Get-Content -LiteralPath $ProfilePath) {
            if ($Line -match "^ADAPTER_CHOICES=(.*)$") {
                $InstalledAdapters += $Matches[1].Split(",") | Where-Object { $_ }
            }
        }
    }
    if ($AdapterChoice -eq "5") {
        $InstalledAdapters += @("1", "2", "3", "4")
    } else {
        $InstalledAdapters += $AdapterChoice
    }
    $InstalledAdapters = @($InstalledAdapters | Sort-Object -Unique)

    @(
        "SOURCE_REPO=$RepoUrl"
        "SOURCE_REF=master"
        "PACK_CHOICE=$PackChoice"
        "ADAPTER_CHOICES=$($InstalledAdapters -join ',')"
    ) | Set-Content -LiteralPath $ProfilePath

    Copy-Item -LiteralPath (Join-Path $SourceDir "scripts\update-scaffold.ps1") -Destination (Join-Path $ProfileDir "update.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $SourceDir "scripts\update-scaffold.sh") -Destination (Join-Path $ProfileDir "update.sh") -Force

    $InfoExclude = Join-Path $TargetDir ".git\info\exclude"
    if (Test-Path (Join-Path $TargetDir ".git")) {
        $ExcludeEntry = ".agent-scaffold/"
        $ExistingExclude = if (Test-Path -LiteralPath $InfoExclude) { Get-Content -LiteralPath $InfoExclude } else { @() }
        if ($ExistingExclude -notcontains $ExcludeEntry) {
            Add-Content -LiteralPath $InfoExclude -Value $ExcludeEntry
        }
    }

    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "   Installation Completed Successfully!      " -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
} finally {
    & $Cleanup
}
