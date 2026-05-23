param(
    [ValidateSet('snapshot', 'trim', 'codex-scan', 'codex-clean', 'codex-self-test')]
    [string]$Mode = 'snapshot',
    [int]$MinProcessMB = 180,
    [string]$Reason = 'manual',
    [string]$DataDir = '',
    [int]$CodexStaleMinutes = 10,
    [int]$CodexMaxMcpProcesses = 40,
    [int]$CodexCommitPressurePercent = 85,
    [string]$CodexCleanWhileRunning = 'current-safe',
    [int]$CodexMaxKillsPerPass = 0,
    [string]$CodexAllowedReasonsJson = '',
    [string]$CodexDryRun = 'true',
    [string]$CodexKillAllowlistJson = ''
)

$ErrorActionPreference = 'SilentlyContinue'

$validCodexCleanWhileRunningModes = @('report-only', 'orphan-only', 'current-safe', 'allow-stale')
if ($validCodexCleanWhileRunningModes -notcontains $CodexCleanWhileRunning) {
    $CodexCleanWhileRunning = 'current-safe'
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = $root
}
$logDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("memguard-" + (Get-Date -Format 'yyyyMMdd') + ".log")
$stateFile = Join-Path $DataDir 'last-trim.txt'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeMemoryTools
{
    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(IntPtr hProcess);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Get-Snapshot {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalKb = [double]$os.TotalVisibleMemorySize
    $freeKb = [double]$os.FreePhysicalMemory
    $usedPercent = [math]::Round((1 - ($freeKb / $totalKb)) * 100, 1)
    $totalVirtualKb = [double]$os.TotalVirtualMemorySize
    $freeVirtualKb = [double]$os.FreeVirtualMemory
    $commitUsedKb = $totalVirtualKb - $freeVirtualKb
    $commitPercent = if ($totalVirtualKb -gt 0) {
        [math]::Round(($commitUsedKb / $totalVirtualKb) * 100, 1)
    } else {
        0
    }

    $lastTrim = $null
    if (Test-Path -LiteralPath $stateFile) {
        $raw = Get-Content -LiteralPath $stateFile -Raw
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse($raw, [ref]$parsed)) {
            $lastTrim = $parsed.ToString('o')
        }
    }

    [pscustomobject]@{
        totalGB = [math]::Round($totalKb / 1MB, 2)
        freeGB = [math]::Round($freeKb / 1MB, 2)
        usedGB = [math]::Round(($totalKb - $freeKb) / 1MB, 2)
        usedPercent = $usedPercent
        commitUsedGB = [math]::Round($commitUsedKb / 1MB, 2)
        commitTotalGB = [math]::Round($totalVirtualKb / 1MB, 2)
        commitPercent = $commitPercent
        lastTrim = $lastTrim
        timestamp = (Get-Date).ToString('o')
    }
}

function Convert-ToBool {
    param([object]$Value, [bool]$Default = $false)
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $Default }
    return @('1', 'true', 'yes', 'y', 'on') -contains $text.Trim().ToLowerInvariant()
}

function Convert-CimDate {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value }
    try {
        return [Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)
    } catch {
        return $null
    }
}

function Get-CodexAllowlist {
    $fallback = @(
        '@shell-mcp/mcp-lite',
        'shell-mcp-lite',
        '@modelcontextprotocol/server-filesystem',
        '@modelcontextprotocol/server-sequential-thinking',
        '@modelcontextprotocol/server-memory',
        '@modelcontextprotocol/server-everything',
        '@modelcontextprotocol/server-fetch',
        '@modelcontextprotocol/server-git',
        '@modelcontextprotocol/server-puppeteer',
        'node_repl.exe'
    )

    if ([string]::IsNullOrWhiteSpace($CodexKillAllowlistJson)) {
        return $fallback
    }

    try {
        $parsed = $CodexKillAllowlistJson | ConvertFrom-Json
        $items = @($parsed) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ }
        if ($items.Count -gt 0) { return $items }
    } catch {}

    return $fallback
}

function Get-CodexAllowedReasons {
    if ([string]::IsNullOrWhiteSpace($CodexAllowedReasonsJson)) {
        return @()
    }

    try {
        $parsed = $CodexAllowedReasonsJson | ConvertFrom-Json
        return @($parsed) |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
            ForEach-Object { [string]$_ }
    } catch {}

    return @()
}

function Test-CommandContainsAny {
    param(
        [string]$CommandLine,
        [string[]]$Needles
    )
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $normalizedCommand = $CommandLine -replace '\\', '/'
    foreach ($needle in $Needles) {
        if ([string]::IsNullOrWhiteSpace($needle)) { continue }
        $normalizedNeedle = ([string]$needle) -replace '\\', '/'
        if ($CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $normalizedCommand.IndexOf($normalizedNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Test-CodexProcess {
    param([object]$Process)
    if ($null -eq $Process) { return $false }
    if ($Process.Name -notin @('Codex.exe', 'codex.exe')) { return $false }
    $cmd = [string]$Process.CommandLine
    return ($cmd.IndexOf('\OpenAI\Codex\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('OpenAI.Codex_', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Test-CodexDesktopRoot {
    param([object]$Process)
    if ($null -eq $Process) { return $false }
    if ($Process.Name -ne 'Codex.exe') { return $false }
    $cmd = [string]$Process.CommandLine
    return ($cmd.IndexOf('OpenAI.Codex_', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $cmd.IndexOf(' --type=', [StringComparison]::OrdinalIgnoreCase) -lt 0)
}

function Test-CodexDesktopAppServer {
    param([object]$Process)
    if ($null -eq $Process) { return $false }
    if ($Process.Name -ne 'codex.exe') { return $false }
    $cmd = [string]$Process.CommandLine
    return ($cmd.IndexOf('\app\resources\codex.exe', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $cmd.IndexOf('app-server --analytics-default-enabled', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Test-CodexStdioAppServer {
    param([object]$Process)
    if ($null -eq $Process) { return $false }
    if ($Process.Name -ne 'codex.exe') { return $false }
    $cmd = [string]$Process.CommandLine
    return ($cmd.IndexOf('app-server --listen stdio://', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Get-CodexChainKind {
    param([object]$ChainInfo)
    if ($null -eq $ChainInfo -or $null -eq $ChainInfo.chain) { return 'none' }
    if ($ChainInfo.chain | Where-Object { Test-CodexStdioAppServer $_ } | Select-Object -First 1) { return 'stdio-app-server' }
    if ($ChainInfo.chain | Where-Object { Test-CodexDesktopAppServer $_ } | Select-Object -First 1) { return 'desktop-app-server' }
    if ($ChainInfo.chain | Where-Object { Test-CodexDesktopRoot $_ } | Select-Object -First 1) { return 'desktop-root' }
    if ($ChainInfo.chain | Where-Object { Test-CodexProcess $_ } | Select-Object -First 1) { return 'codex-other' }
    return 'none'
}

function Get-CodexToolKey {
    param([string]$CommandLine)
    $cmd = ([string]$CommandLine).ToLowerInvariant() -replace '\s+', ' '
    $normalized = $cmd -replace '\\', '/'
    if ($normalized -match '@modelcontextprotocol/server-filesystem') {
        $pathMatch = [regex]::Match($normalized, 'server-filesystem\s+["'']?([^"'']+)')
        $pathKey = if ($pathMatch.Success) { $pathMatch.Groups[1].Value.Trim() } else { 'unknown' }
        return "filesystem:${pathKey}:$($normalized -match 'cmd\.exe'):$($normalized -match 'node\.exe|node_modules')"
    }
    if ($normalized -match '@modelcontextprotocol/server-sequential-thinking|server-sequential-thinking') {
        return "sequential:$($normalized -match 'cmd\.exe'):$($normalized -match 'node\.exe|node_modules')"
    }
    if ($normalized -match '@shell-mcp/mcp-lite|shell-mcp-lite') {
        return "shell-mcp-lite:$($normalized -match 'cmd\.exe /d /s /c shell-mcp-lite'):$($normalized -match 'npx|npm-cli'):$($normalized -match 'node\.exe|node_modules')"
    }
    if ($normalized -match 'node_repl') {
        return 'node-repl'
    }
    return $normalized
}

function Get-CodexGroupLabel {
    param(
        [string]$ChainKind,
        [string]$ToolKey
    )

    $root = switch ($ChainKind) {
        'desktop-app-server' { 'Codex Desktop app-server' }
        'stdio-app-server' { 'Codex stdio app-server' }
        'desktop-root' { 'Codex desktop root' }
        'codex-other' { 'Codex process tree' }
        default { 'Detached tool chain' }
    }

    $tool = if ($ToolKey -match '^filesystem:') {
        'filesystem MCP'
    } elseif ($ToolKey -match '^sequential:') {
        'sequential-thinking MCP'
    } elseif ($ToolKey -match '^shell-mcp-lite:') {
        'shell MCP'
    } elseif ($ToolKey -eq 'node-repl') {
        'node REPL'
    } elseif ([string]::IsNullOrWhiteSpace($ToolKey)) {
        'unknown tool'
    } else {
        $ToolKey
    }

    return "$root / $tool"
}

function Measure-ProcessMemoryMB {
    param(
        [object[]]$Processes,
        [string]$Property
    )

    $sum = (@($Processes) | Measure-Object -Property $Property -Sum).Sum
    if ($null -eq $sum) { $sum = 0 }
    return [math]::Round(([double]$sum) / 1MB, 1)
}

function Test-SafeTrimSkipProcess {
    param(
        [object]$Process,
        [string]$CommandLine = ''
    )

    if ($null -eq $Process) { return $true }

    $name = ''
    if ($Process.PSObject.Properties['ProcessName']) {
        $name = [string]$Process.ProcessName
    } elseif ($Process.PSObject.Properties['Name']) {
        $name = ([string]$Process.Name) -replace '\.exe$', ''
    }

    if ($name -in @('Codex', 'codex', 'chrome', 'msedge', 'electron', 'Code', 'Cursor')) {
        return $true
    }

    $cmd = [string]$CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd) -and $Process.PSObject.Properties['CommandLine']) {
        $cmd = [string]$Process.CommandLine
    }

    if ($cmd.IndexOf('OpenAI.Codex_', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('\OpenAI\Codex\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('--type=renderer', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('--type=gpu-process', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('--type=utility', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('--type=crashpad-handler', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('Electron', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmd.IndexOf('Chromium', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
    }

    if ($name -eq 'node') {
        if ([string]::IsNullOrWhiteSpace($cmd)) { return $true }
        return (Test-CommandContainsAny $cmd @(
            'node_modules',
            'npm-cli.js',
            'npx-cli.js',
            'vite\bin\vite',
            '@modelcontextprotocol/',
            '@shell-mcp/mcp-lite',
            'node_repl',
            'playwright',
            'cloudflared'
        ))
    }

    return $false
}

function Get-ProcessChain {
    param(
        [object]$Process,
        [hashtable]$ProcessById
    )

    $chain = @()
    $visited = @{}
    $current = $Process
    $depth = 0
    $missingParentPid = $null

    while ($null -ne $current -and $depth -lt 40) {
        $processIdValue = [int]$current.ProcessId
        if ($visited.ContainsKey($processIdValue)) { break }
        $visited[$processIdValue] = $true
        $chain += [pscustomobject]@{
            pid = $processIdValue
            parentPid = [int]$current.ParentProcessId
            name = [string]$current.Name
            commandLine = [string]$current.CommandLine
        }

        $parentPid = [int]$current.ParentProcessId
        if (-not $ProcessById.ContainsKey($parentPid)) {
            $missingParentPid = $parentPid
            break
        }

        $current = $ProcessById[$parentPid]
        $depth++
    }

    [pscustomobject]@{
        chain = $chain
        depth = $chain.Count - 1
        hasCodexAncestor = [bool]($chain | Where-Object { Test-CodexProcess $_ } | Select-Object -First 1)
        missingParentPid = $missingParentPid
        root = if ($chain.Count -gt 0) { $chain[-1] } else { $null }
    }
}

function Convert-ProcessSummary {
    param(
        [object]$Process,
        [string]$Category,
        [string]$Reason,
        [object]$ChainInfo,
        [string]$ChainKind = '',
        [string]$ToolKey = '',
        [int]$DuplicateRank = 0,
        [int]$DuplicateCount = 0
    )

    $created = Convert-CimDate $Process.CreationDate
    $ageMinutes = if ($created) {
        [math]::Round(((Get-Date) - $created).TotalMinutes, 1)
    } else {
        $null
    }

    $cmd = [string]$Process.CommandLine
    if ($cmd.Length -gt 260) {
        $cmd = $cmd.Substring(0, 257) + '...'
    }

    [pscustomobject]@{
        pid = [int]$Process.ProcessId
        parentPid = [int]$Process.ParentProcessId
        name = [string]$Process.Name
        category = $Category
        reason = $Reason
        ageMinutes = $ageMinutes
        workingSetMB = [math]::Round(([double]$Process.WorkingSetSize) / 1MB, 1)
        privateMB = [math]::Round(([double]$Process.PrivatePageCount) / 1MB, 1)
        commandLine = $cmd
        createdAt = if ($created) { $created.ToString('o') } else { $null }
        chainKind = $ChainKind
        toolKey = $ToolKey
        duplicateRank = $DuplicateRank
        duplicateCount = $DuplicateCount
        chain = @($ChainInfo.chain | Select-Object -First 10)
        chainDepth = $ChainInfo.depth
        missingParentPid = $ChainInfo.missingParentPid
    }
}

function New-TestProcess {
    param(
        [int]$Id,
        [int]$ParentId,
        [string]$Name,
        [string]$CommandLine,
        [datetime]$Created,
        [int]$WorkingSetMB = 10,
        [int]$PrivateMB = 10
    )

    [pscustomobject]@{
        ProcessId = $Id
        ParentProcessId = $ParentId
        Name = $Name
        CommandLine = $CommandLine
        CreationDate = $Created
        WorkingSetSize = $WorkingSetMB * 1MB
        PrivatePageCount = $PrivateMB * 1MB
    }
}

function Get-CodexGuardScan {
    param(
        [object[]]$InputProcesses = $null,
        [object]$InputSnapshot = $null,
        [datetime]$InputNow = (Get-Date)
    )

    $snapshot = if ($InputSnapshot) { $InputSnapshot } else { Get-Snapshot }
    $allowlist = Get-CodexAllowlist
    $now = $InputNow
    $processes = if ($InputProcesses) { @($InputProcesses) } else { @(Get-CimInstance Win32_Process) }
    $byId = @{}
    foreach ($proc in $processes) {
        $byId[[int]$proc.ProcessId] = $proc
    }

    $codexProcesses = @($processes | Where-Object { Test-CodexProcess $_ })
    $codexDesktopRoots = @($processes | Where-Object { Test-CodexDesktopRoot $_ })
    $codexDesktopAppServers = @($processes | Where-Object { Test-CodexDesktopAppServer $_ })
    $codexStdioAppServers = @($processes | Where-Object { Test-CodexStdioAppServer $_ })
    $sessionStartSource = if ($codexDesktopRoots.Count -gt 0) { $codexDesktopRoots } else { $codexProcesses }
    $sessionStartDates = @($sessionStartSource |
        ForEach-Object { Convert-CimDate $_.CreationDate } |
        Where-Object { $null -ne $_ } |
        Sort-Object)
    $codexSessionStartedAt = if ($sessionStartDates.Count -gt 0) { $sessionStartDates[0] } else { $null }
    $codexPreviousSessionCutoff = if ($codexSessionStartedAt) { $codexSessionStartedAt.AddMinutes(-2) } else { $null }
    $codexRunning = $codexProcesses.Count -gt 0
    $candidates = @()
    $protected = @()
    $suspicious = @()
    $cleanable = @()
    $reportOnly = @()
    $candidateRecords = @()
    $pressureHigh = ($snapshot.commitPercent -ge $CodexCommitPressurePercent)

    foreach ($proc in $processes) {
        if ($proc.Name -notin @('node.exe', 'cmd.exe')) { continue }
        $cmd = [string]$proc.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }

        $isAllowlisted = Test-CommandContainsAny $cmd $allowlist
        $looksLikeDevServer = ($cmd -match 'vite\\bin\\vite|npm-cli\.js\"?\s+run\s+dev|npm\s+run\s+dev|node_modules\\\.bin\\vite|cloudflared|playwright')
        if (-not $isAllowlisted -and -not $looksLikeDevServer) { continue }

        $chain = Get-ProcessChain $proc $byId
        $created = Convert-CimDate $proc.CreationDate
        $ageMinutes = if ($created) { (($now - $created).TotalMinutes) } else { 0 }
        $rootName = if ($chain.root) { [string]$chain.root.name } else { '' }
        $orphanGroup = ($null -ne $chain.missingParentPid -and $rootName -in @('node.exe', 'cmd.exe'))
        $previousSessionOrphan = ($orphanGroup -and
            $created -and
            $codexPreviousSessionCutoff -and
            $created -lt $codexPreviousSessionCutoff)

        if ($looksLikeDevServer -and -not $isAllowlisted) {
            $reportOnly += Convert-ProcessSummary $proc 'report-only' 'non-codex-dev-server-pattern' $chain
            continue
        }

        $chainKind = Get-CodexChainKind $chain
        $toolKey = Get-CodexToolKey $cmd
        $candidates += $proc
        $candidateRecords += [pscustomobject]@{
            process = $proc
            chain = $chain
            created = $created
            ageMinutes = $ageMinutes
            rootName = $rootName
            orphanGroup = $orphanGroup
            previousSessionOrphan = $previousSessionOrphan
            chainKind = $chainKind
            toolKey = $toolKey
            duplicateKey = "${chainKind}|${toolKey}"
            duplicateRank = 0
            duplicateCount = 1
            category = ''
            reason = ''
        }
    }

    foreach ($group in ($candidateRecords | Group-Object -Property duplicateKey)) {
        $ordered = @($group.Group | Sort-Object @{ Expression = { if ($_.created) { $_.created } else { [datetime]::MinValue } }; Descending = $true })
        $rank = 0
        foreach ($record in $ordered) {
            $rank++
            $record.duplicateRank = $rank
            $record.duplicateCount = $ordered.Count
        }
    }

    $desktopDuplicateKeep = 2
    foreach ($record in $candidateRecords) {
        $proc = $record.process
        $chain = $record.chain
        $chainKind = $record.chainKind
        $ageMinutes = $record.ageMinutes
        $isDuplicateOld = ($record.duplicateCount -gt $desktopDuplicateKeep -and $record.duplicateRank -gt $desktopDuplicateKeep)

        if ($chainKind -eq 'stdio-app-server') {
            $record.category = 'protected'
            $record.reason = 'live-stdio-app-server'
        } elseif ($chainKind -eq 'desktop-app-server') {
            if ($ageMinutes -lt $CodexStaleMinutes) {
                $record.category = 'protected'
                $record.reason = "desktop-app-server-younger-than-${CodexStaleMinutes}m"
            } elseif ($isDuplicateOld -and $CodexCleanWhileRunning -eq 'report-only') {
                $record.category = 'suspicious'
                $record.reason = 'duplicate-desktop-app-server-tool-report-only'
            } elseif ($isDuplicateOld -and ($pressureHigh -or $candidates.Count -gt $CodexMaxMcpProcesses -or $CodexCleanWhileRunning -eq 'allow-stale' -or $CodexCleanWhileRunning -eq 'current-safe')) {
                $record.category = 'cleanable'
                $record.reason = 'duplicate-desktop-app-server-tool'
            } elseif ($isDuplicateOld) {
                $record.category = 'suspicious'
                $record.reason = 'duplicate-desktop-app-server-tool-pressure-not-met'
            } else {
                $record.category = 'protected'
                $record.reason = 'live-desktop-app-server-latest-or-singleton'
            }
        } elseif ($chainKind -in @('desktop-root', 'codex-other')) {
            $record.category = 'protected'
            $record.reason = "live-$chainKind"
        } elseif ($ageMinutes -lt $CodexStaleMinutes) {
            $record.category = 'suspicious'
            $record.reason = "allowlisted-but-younger-than-${CodexStaleMinutes}m"
        } elseif ($record.orphanGroup -and -not $codexRunning) {
            $record.category = 'cleanable'
            $record.reason = 'codex-not-running-and-allowlisted-orphan'
        } elseif ($record.orphanGroup -and $CodexCleanWhileRunning -in @('orphan-only', 'current-safe') -and $record.previousSessionOrphan) {
            $record.category = 'cleanable'
            $record.reason = 'previous-codex-session-orphan-while-running'
        } elseif ($record.orphanGroup -and $CodexCleanWhileRunning -eq 'allow-stale') {
            $record.category = 'cleanable'
            $record.reason = 'allow-stale-orphan-while-codex-running'
        } else {
            $record.category = 'suspicious'
            $record.reason = 'allowlisted-stale-but-parent-chain-not-cleanable'
        }

        $summary = Convert-ProcessSummary $proc $record.category $record.reason $chain $record.chainKind $record.toolKey $record.duplicateRank $record.duplicateCount
        if ($record.category -eq 'protected') {
            $protected += $summary
        } elseif ($record.category -eq 'cleanable') {
            $cleanable += $summary
        } else {
            $suspicious += $summary
        }
    }

    $candidateWorkingSet = Measure-ProcessMemoryMB $candidates 'WorkingSetSize'
    $candidatePrivate = Measure-ProcessMemoryMB $candidates 'PrivatePageCount'
    $candidateGroups = @($candidateRecords |
        Group-Object -Property duplicateKey |
        ForEach-Object {
            $items = @($_.Group)
            $orderedItems = @($items | Sort-Object @{ Expression = { if ($_.category -eq 'cleanable') { 0 } elseif ($_.category -eq 'suspicious') { 1 } else { 2 } } }, @{ Expression = 'ageMinutes'; Descending = $true })
            [pscustomobject]@{
                key = $_.Name
                label = Get-CodexGroupLabel ($items[0].chainKind) ($items[0].toolKey)
                toolKey = $items[0].toolKey
                chainKind = $items[0].chainKind
                count = $_.Count
                protectedCount = @($items | Where-Object { $_.category -eq 'protected' }).Count
                suspiciousCount = @($items | Where-Object { $_.category -eq 'suspicious' }).Count
                cleanableCount = @($items | Where-Object { $_.category -eq 'cleanable' }).Count
                oldestAgeMinutes = [math]::Round((($items | Measure-Object ageMinutes -Maximum).Maximum), 1)
                newestAgeMinutes = [math]::Round((($items | Measure-Object ageMinutes -Minimum).Minimum), 1)
                workingSetMB = Measure-ProcessMemoryMB @($items | ForEach-Object { $_.process }) 'WorkingSetSize'
                privateMB = Measure-ProcessMemoryMB @($items | ForEach-Object { $_.process }) 'PrivatePageCount'
                items = @($orderedItems | Select-Object -First 18 | ForEach-Object {
                    Convert-ProcessSummary $_.process $_.category $_.reason $_.chain $_.chainKind $_.toolKey $_.duplicateRank $_.duplicateCount
                })
            }
        } |
        Sort-Object cleanableCount, privateMB, count -Descending |
        Select-Object -First 60)
    $duplicateGroups = @($candidateRecords |
        Group-Object -Property duplicateKey |
        Where-Object { $_.Count -gt 1 } |
        ForEach-Object {
            $items = @($_.Group)
            [pscustomobject]@{
                key = $_.Name
                label = Get-CodexGroupLabel ($items[0].chainKind) ($items[0].toolKey)
                toolKey = $items[0].toolKey
                chainKind = $items[0].chainKind
                count = $_.Count
                protectedCount = @($items | Where-Object { $_.category -eq 'protected' }).Count
                suspiciousCount = @($items | Where-Object { $_.category -eq 'suspicious' }).Count
                cleanableCount = @($items | Where-Object { $_.category -eq 'cleanable' }).Count
                oldestAgeMinutes = [math]::Round((($items | Measure-Object ageMinutes -Maximum).Maximum), 1)
                newestAgeMinutes = [math]::Round((($items | Measure-Object ageMinutes -Minimum).Minimum), 1)
                workingSetMB = Measure-ProcessMemoryMB @($items | ForEach-Object { $_.process }) 'WorkingSetSize'
                privateMB = Measure-ProcessMemoryMB @($items | ForEach-Object { $_.process }) 'PrivatePageCount'
                chainKinds = @($items | Select-Object -ExpandProperty chainKind -Unique)
            }
        } |
        Sort-Object cleanableCount, count -Descending |
        Select-Object -First 40)

    [pscustomobject]@{
        timestamp = $now.ToString('o')
        snapshot = $snapshot
        thresholds = [pscustomobject]@{
            staleMinutes = $CodexStaleMinutes
            maxMcpProcesses = $CodexMaxMcpProcesses
            commitPressurePercent = $CodexCommitPressurePercent
            cleanWhileRunning = $CodexCleanWhileRunning
        }
        codex = [pscustomobject]@{
            running = $codexRunning
            count = $codexProcesses.Count
            desktopRootCount = $codexDesktopRoots.Count
            desktopAppServerCount = $codexDesktopAppServers.Count
            stdioAppServerCount = $codexStdioAppServers.Count
            sessionStartedAt = if ($codexSessionStartedAt) { $codexSessionStartedAt.ToString('o') } else { $null }
            processes = @($codexProcesses | ForEach-Object {
                [pscustomobject]@{
                    pid = [int]$_.ProcessId
                    parentPid = [int]$_.ParentProcessId
                    name = [string]$_.Name
                    workingSetMB = [math]::Round(([double]$_.WorkingSetSize) / 1MB, 1)
                    commandLine = [string]$_.CommandLine
                }
            })
        }
        summary = [pscustomobject]@{
            candidateCount = $candidates.Count
            protectedCount = $protected.Count
            suspiciousCount = $suspicious.Count
            cleanableCount = $cleanable.Count
            reportOnlyCount = $reportOnly.Count
            candidateWorkingSetMB = $candidateWorkingSet
            candidatePrivateMB = $candidatePrivate
            candidateGroupCount = $candidateGroups.Count
            duplicateGroupCount = $duplicateGroups.Count
            desktopAppServerCandidateCount = @($candidateRecords | Where-Object { $_.chainKind -eq 'desktop-app-server' }).Count
            stdioAppServerCandidateCount = @($candidateRecords | Where-Object { $_.chainKind -eq 'stdio-app-server' }).Count
            overProcessLimit = $candidates.Count -gt $CodexMaxMcpProcesses
            overCommitPressure = $snapshot.commitPercent -ge $CodexCommitPressurePercent
        }
        candidateGroups = $candidateGroups
        duplicateGroups = $duplicateGroups
        protected = @($protected | Sort-Object workingSetMB -Descending | Select-Object -First 80)
        suspicious = @($suspicious | Sort-Object workingSetMB -Descending | Select-Object -First 80)
        cleanable = @($cleanable | Sort-Object @{ Expression = 'chainDepth'; Descending = $true }, @{ Expression = 'workingSetMB'; Descending = $true } | Select-Object -First 1000)
        reportOnly = @($reportOnly | Sort-Object workingSetMB -Descending | Select-Object -First 40)
    }
}

function Invoke-CodexClean {
    $dryRun = Convert-ToBool $CodexDryRun $true
    $before = Get-CodexGuardScan
    $allowedReasons = @(Get-CodexAllowedReasons)
    $targets = @($before.cleanable)
    if ($allowedReasons.Count -gt 0) {
        $targets = @($targets | Where-Object { $allowedReasons -contains $_.reason })
    }
    if ($CodexMaxKillsPerPass -gt 0) {
        $targets = @($targets | Select-Object -First $CodexMaxKillsPerPass)
    }
    Write-Log "Codex clean start: reason=$Reason dryRun=$dryRun targets=$($targets.Count) codexRunning=$($before.codex.running) commit=$($before.snapshot.commitPercent)% allowedReasons=$($allowedReasons -join ',') maxKills=$CodexMaxKillsPerPass"

    $killed = @()
    $failed = @()

    if (-not $dryRun) {
        $freshScan = Get-CodexGuardScan
        $freshByIdentity = @{}
        $freshTargets = @($freshScan.cleanable)
        if ($allowedReasons.Count -gt 0) {
            $freshTargets = @($freshTargets | Where-Object { $allowedReasons -contains $_.reason })
        }
        foreach ($freshTarget in $freshTargets) {
            $freshByIdentity["$($freshTarget.pid)|$($freshTarget.createdAt)|$($freshTarget.toolKey)"] = $freshTarget
        }

        $validatedTargets = @()
        foreach ($target in $targets) {
            $identity = "$($target.pid)|$($target.createdAt)|$($target.toolKey)"
            if ($freshByIdentity.ContainsKey($identity)) {
                $validatedTargets += $freshByIdentity[$identity]
            } else {
                Write-Log "Codex skip revalidated: pid=$($target.pid) name=$($target.name) reason=$($target.reason) key=$($target.toolKey)"
            }
        }

        foreach ($target in ($validatedTargets | Sort-Object @{ Expression = 'chainDepth'; Descending = $true }, @{ Expression = 'pid'; Descending = $true })) {
            try {
                $liveProcess = Get-Process -Id ([int]$target.pid) -ErrorAction SilentlyContinue
                if ($null -eq $liveProcess) {
                    continue
                }
                $liveWmi = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.pid)" -ErrorAction SilentlyContinue
                if ($null -eq $liveWmi) {
                    continue
                }
                $liveCreated = Convert-CimDate $liveWmi.CreationDate
                $liveCreatedText = if ($liveCreated) { $liveCreated.ToString('o') } else { $null }
                $liveKey = Get-CodexToolKey ([string]$liveWmi.CommandLine)
                if ($liveCreatedText -ne $target.createdAt -or $liveKey -ne $target.toolKey) {
                    Write-Log "Codex skip identity changed: pid=$($target.pid) expectedCreated=$($target.createdAt) actualCreated=$liveCreatedText expectedKey=$($target.toolKey) actualKey=$liveKey"
                    continue
                }
                Stop-Process -Id ([int]$target.pid) -Force -ErrorAction Stop
                $killed += $target
                Write-Log "Codex killed: pid=$($target.pid) name=$($target.name) reason=$($target.reason) cmd=$($target.commandLine)"
            } catch {
                $failed += [pscustomobject]@{
                    pid = $target.pid
                    name = $target.name
                    error = $_.Exception.Message
                    reason = $target.reason
                }
                Write-Log "Codex kill failed: pid=$($target.pid) name=$($target.name) error=$($_.Exception.Message)"
            }
        }
        Start-Sleep -Milliseconds 800
    }

    $after = if ($dryRun) { $before } else { Get-CodexGuardScan }
    Write-Log "Codex clean done: dryRun=$dryRun killed=$($killed.Count) failed=$($failed.Count) cleanableBefore=$($targets.Count) cleanableAfter=$($after.summary.cleanableCount)"

    [pscustomobject]@{
        dryRun = $dryRun
        before = $before
        after = $after
        targets = $targets
        killed = $killed
        failed = $failed
        killedCount = $killed.Count
        failedCount = $failed.Count
        targetCount = $targets.Count
    }
}

function Invoke-CodexSelfTest {
    $now = Get-Date
    $currentSessionStart = $now.AddMinutes(-30)
    $snapshot = [pscustomobject]@{
        commitPercent = 91
        usedPercent = 70
        freeGB = 4
        totalGB = 16
        timestamp = $now.ToString('o')
    }

    $processes = @(
        New-TestProcess 100 1 'Codex.exe' '"C:\Program Files\WindowsApps\OpenAI.Codex_test\app\Codex.exe"' $currentSessionStart 120 100
        New-TestProcess 110 100 'codex.exe' '"C:\Users\user\AppData\Local\OpenAI\Codex\bin\abc\codex.exe" app-server --listen stdio://' $currentSessionStart.AddMinutes(1) 80 80
        New-TestProcess 200 110 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(2) 5 5
        New-TestProcess 201 200 'node.exe' 'node.exe npm-cli.js exec @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(2) 40 100
        New-TestProcess 202 201 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c shell-mcp-lite' $currentSessionStart.AddMinutes(2) 5 5

        New-TestProcess 300 9999 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(-20) 5 5
        New-TestProcess 301 300 'node.exe' 'node.exe npm-cli.js exec @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(-20) 40 100
        New-TestProcess 302 301 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c shell-mcp-lite' $currentSessionStart.AddMinutes(-20) 5 5

        New-TestProcess 400 8888 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(5) 5 5
        New-TestProcess 401 400 'node.exe' 'node.exe npm-cli.js exec @shell-mcp/mcp-lite' $currentSessionStart.AddMinutes(5) 40 100
        New-TestProcess 402 401 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c shell-mcp-lite' $currentSessionStart.AddMinutes(5) 5 5

        New-TestProcess 700 100 'codex.exe' '"C:\Program Files\WindowsApps\OpenAI.Codex_test\app\resources\codex.exe" app-server --analytics-default-enabled' $currentSessionStart.AddMinutes(1) 70 70
        New-TestProcess 710 700 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(2) 5 5
        New-TestProcess 711 710 'node.exe' 'node.exe npm-cli.js exec @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(2) 40 120
        New-TestProcess 720 700 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-5) 5 5
        New-TestProcess 721 720 'node.exe' 'node.exe npm-cli.js exec @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-5) 40 120
        New-TestProcess 730 700 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-10) 5 5
        New-TestProcess 731 730 'node.exe' 'node.exe npm-cli.js exec @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-10) 40 120
        New-TestProcess 740 700 'cmd.exe' 'C:\Windows\system32\cmd.exe /d /s /c npx -y @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-15) 5 5
        New-TestProcess 741 740 'node.exe' 'node.exe npm-cli.js exec @modelcontextprotocol/server-filesystem E:\claude code' $currentSessionStart.AddMinutes(-15) 40 120

        New-TestProcess 500 1 'cmd.exe' 'cmd.exe /c npm run dev' $currentSessionStart.AddMinutes(-10) 5 5
        New-TestProcess 501 500 'node.exe' 'node.exe E:\project\node_modules\vite\bin\vite.js --host 127.0.0.1' $currentSessionStart.AddMinutes(-10) 100 200
    )

    $scan = Get-CodexGuardScan -InputProcesses $processes -InputSnapshot $snapshot -InputNow $now
    $originalMode = $CodexCleanWhileRunning
    $CodexCleanWhileRunning = 'report-only'
    $reportOnlyScan = Get-CodexGuardScan -InputProcesses $processes -InputSnapshot $snapshot -InputNow $now
    $CodexCleanWhileRunning = $originalMode
    $assertions = @(
        [pscustomobject]@{ name = 'live codex chain protected'; passed = [bool]($scan.protected | Where-Object { $_.pid -eq 200 -or $_.pid -eq 201 -or $_.pid -eq 202 }) }
        [pscustomobject]@{ name = 'previous session orphan cleanable'; passed = [bool]($scan.cleanable | Where-Object { $_.pid -eq 300 -or $_.pid -eq 301 -or $_.pid -eq 302 }) }
        [pscustomobject]@{ name = 'current session orphan suspicious'; passed = [bool]($scan.suspicious | Where-Object { $_.pid -eq 400 -or $_.pid -eq 401 -or $_.pid -eq 402 }) }
        [pscustomobject]@{ name = 'old duplicate desktop app-server cleanable in current-safe'; passed = [bool]($scan.cleanable | Where-Object { $_.pid -eq 740 -or $_.pid -eq 741 }) }
        [pscustomobject]@{ name = 'report-only keeps running codex cleanable empty'; passed = (@($reportOnlyScan.cleanable).Count -eq 0) }
        [pscustomobject]@{ name = 'vite dev server report-only'; passed = [bool]($scan.reportOnly | Where-Object { $_.pid -eq 500 -or $_.pid -eq 501 }) }
        [pscustomobject]@{ name = 'candidate groups include all groups'; passed = ($scan.summary.candidateGroupCount -ge 3 -and @($scan.candidateGroups).Count -eq $scan.summary.candidateGroupCount) }
        [pscustomobject]@{ name = 'candidate groups expose memory totals'; passed = [bool]($scan.candidateGroups | Where-Object { $_.cleanableCount -gt 0 -and $_.privateMB -gt 0 -and $_.workingSetMB -gt 0 } | Select-Object -First 1) }
        [pscustomobject]@{ name = 'safe trim skips codex desktop'; passed = (Test-SafeTrimSkipProcess (New-TestProcess 600 1 'Codex.exe' '"C:\Program Files\WindowsApps\OpenAI.Codex_test\app\Codex.exe" --type=renderer' $now 500 500) '') }
        [pscustomobject]@{ name = 'safe trim skips electron renderer'; passed = (Test-SafeTrimSkipProcess (New-TestProcess 601 1 'electron.exe' '"D:\app\electron.exe" --type=gpu-process' $now 500 500) '') }
        [pscustomobject]@{ name = 'safe trim skips node dev tool'; passed = (Test-SafeTrimSkipProcess (New-TestProcess 602 1 'node.exe' '"D:\nodejs\node.exe" "D:\project\node_modules\vite\bin\vite.js"' $now 500 500) '') }
        [pscustomobject]@{ name = 'safe trim allows ordinary app'; passed = -not (Test-SafeTrimSkipProcess (New-TestProcess 603 1 'notepad.exe' '"C:\Windows\System32\notepad.exe"' $now 500 500) '') }
    )

    [pscustomobject]@{
        passed = -not [bool]($assertions | Where-Object { -not $_.passed })
        assertions = $assertions
        summary = $scan.summary
    }
}

function Invoke-Trim {
    $before = Get-Snapshot
    Write-Log "Trim start: reason=$Reason used=$($before.usedPercent)% free=$($before.freeGB)GB"

    $skipNames = @(
        'Idle',
        'System',
        'Registry',
        'Memory Compression',
        'Secure System',
        'csrss',
        'wininit',
        'winlogon',
        'services',
        'lsass',
        'smss',
        'dwm',
        'fontdrvhost',
        'audiodg'
    )

    $trimmed = 0
    $currentPid = $PID
    $foregroundPid = 0
    $foregroundWindow = [NativeMemoryTools]::GetForegroundWindow()
    if ($foregroundWindow -ne [IntPtr]::Zero) {
        [uint32]$foregroundPidRef = 0
        [NativeMemoryTools]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundPidRef) | Out-Null
        $foregroundPid = [int]$foregroundPidRef
    }

    $rawCandidates = @(Get-Process |
        Where-Object {
            $_.Id -gt 4 -and
            $_.Id -ne $currentPid -and
            $_.Id -ne $foregroundPid -and
            $_.WorkingSet64 -ge ($MinProcessMB * 1MB) -and
            $skipNames -notcontains $_.ProcessName
        } |
        Sort-Object WorkingSet64 -Descending |
        Select-Object -First 48)

    $candidatePidSet = @{}
    foreach ($candidate in $rawCandidates) {
        $candidatePidSet[[int]$candidate.Id] = $true
    }
    $candidateCommandLines = @{}
    if ($candidatePidSet.Count -gt 0) {
        foreach ($wmiProc in @(Get-CimInstance Win32_Process | Where-Object { $candidatePidSet.ContainsKey([int]$_.ProcessId) })) {
            $candidateCommandLines[[int]$wmiProc.ProcessId] = [string]$wmiProc.CommandLine
        }
    }

    $skippedSensitive = 0
    $candidates = @()
    foreach ($candidate in $rawCandidates) {
        $cmd = if ($candidateCommandLines.ContainsKey([int]$candidate.Id)) { $candidateCommandLines[[int]$candidate.Id] } else { '' }
        if (Test-SafeTrimSkipProcess $candidate $cmd) {
            $skippedSensitive++
            continue
        }
        $candidates += $candidate
        if ($candidates.Count -ge 24) { break }
    }

    foreach ($proc in $candidates) {
        try {
            $handle = $proc.Handle
            if ($handle -eq [IntPtr]::Zero) {
                continue
            }
            if ([NativeMemoryTools]::EmptyWorkingSet($handle)) {
                $trimmed++
            }
        } catch {}
    }

    Start-Sleep -Milliseconds 800
    Set-Content -LiteralPath $stateFile -Value (Get-Date).ToString('o') -Encoding ASCII
    $after = Get-Snapshot
    $freedGB = [math]::Max(0, [math]::Round($after.freeGB - $before.freeGB, 2))
    Write-Log "Trim done: processes=$trimmed used=$($before.usedPercent)%->$($after.usedPercent)% free=$($before.freeGB)GB->$($after.freeGB)GB"

    [pscustomobject]@{
        before = $before
        after = $after
        trimmedProcesses = $trimmed
        freedGB = $freedGB
        skippedForegroundPid = $foregroundPid
        skippedSensitiveProcesses = $skippedSensitive
    }
}

if ($Mode -eq 'trim') {
    Invoke-Trim | ConvertTo-Json -Depth 6 -Compress
} elseif ($Mode -eq 'codex-scan') {
    Get-CodexGuardScan | ConvertTo-Json -Depth 12 -Compress
} elseif ($Mode -eq 'codex-clean') {
    Invoke-CodexClean | ConvertTo-Json -Depth 14 -Compress
} elseif ($Mode -eq 'codex-self-test') {
    Invoke-CodexSelfTest | ConvertTo-Json -Depth 8 -Compress
} else {
    Get-Snapshot | ConvertTo-Json -Depth 4 -Compress
}
