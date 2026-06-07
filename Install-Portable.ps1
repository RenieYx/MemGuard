param(
    [switch]$NoStart,
    [switch]$Quiet,
    [switch]$ForceSilentDefaults
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$startScript = Join-Path $root 'Start-MemGuard.vbs'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemGuard.lnk'
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'MemGuard.lnk'
$taskName = 'MemGuard'
$dataDir = Join-Path $env:APPDATA 'memguard\data'
$configPath = Join-Path $dataDir 'config.json'

function Write-InstallMessage {
    param([string]$Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Cannot find $startScript"
}

$packagedExe = Join-Path $root 'MemGuard.exe'
$sourceElectron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $packagedExe -PathType Leaf) -and -not (Test-Path -LiteralPath $sourceElectron -PathType Leaf)) {
    throw "Cannot find MemGuard.exe or node_modules\electron\dist\electron.exe under $root"
}

$iconPath = @(
    (Join-Path $root 'assets\memguard.ico'),
    (Join-Path $root 'resources\app\assets\memguard.ico'),
    $packagedExe
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell

function Set-JsonProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Target,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    if ($Target.PSObject.Properties.Name -contains $Name) {
        $Target.$Name = $Value
    } else {
        $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Set-MemGuardSilentDefaults {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $config = [pscustomobject]@{}
    $hadConfig = $false
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $hadConfig = $true
        try {
            $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            $backupPath = "$configPath.bak"
            Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
            Write-InstallMessage "Backed up unreadable config to: $backupPath"
            $config = [pscustomobject]@{}
        }
    }

    $policyVersion = 0
    if ($config.PSObject.Properties.Name -contains 'codexPolicyVersion') {
        $policyVersion = [int]$config.codexPolicyVersion
    }
    $applyProfile = $ForceSilentDefaults -or -not $hadConfig -or $policyVersion -lt 3

    foreach ($item in @(
        @{ Name = 'lowResourceMode'; Value = $true },
        @{ Name = 'showWidgetOnStart'; Value = $false },
        @{ Name = 'trimOnStart'; Value = $false },
        @{ Name = 'disableHardwareAcceleration'; Value = $true },
        @{ Name = 'adaptiveCheckIntervalEnabled'; Value = $true }
    )) {
        if ($applyProfile -or -not ($config.PSObject.Properties.Name -contains $item.Name)) {
            Set-JsonProperty -Target $config -Name $item.Name -Value $item.Value
        }
    }

    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
}

function New-MemGuardShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $wscriptPath
    $shortcut.Arguments = "`"$startScript`""
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = 'MemGuard silent background memory guard'
    if ($iconPath) {
        $shortcut.IconLocation = $iconPath
    }
    $shortcut.Save()
}

function Test-ExistingTaskForCurrentScript {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $existingTask) {
        return $false
    }

    foreach ($taskAction in @($existingTask.Actions)) {
        if ($taskAction.Execute -and
            $taskAction.Execute.EndsWith('wscript.exe', [StringComparison]::OrdinalIgnoreCase) -and
            $taskAction.Arguments -and
            $taskAction.Arguments.IndexOf($startScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }

    return $false
}

function Test-MemGuardProcessForCurrentRoot {
    $needles = @(
        $root,
        (Join-Path $root 'resources\app'),
        $startScript
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($process.Name -notin @('MemGuard.exe', 'electron.exe', 'wscript.exe')) {
            continue
        }

        $haystack = @([string]$process.CommandLine, [string]$process.ExecutablePath) -join "`n"
        foreach ($needle in $needles) {
            if ($haystack.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return $true
            }
        }
    }

    return $false
}

Set-MemGuardSilentDefaults
New-MemGuardShortcut -Path $shortcutPath

$startupMode = 'scheduled task'
try {
    $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument "`"$startScript`"" -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'MemGuard: silent low-resource background memory guard.' -Force | Out-Null
    if (Test-Path -LiteralPath $startupShortcutPath) {
        Remove-Item -LiteralPath $startupShortcutPath -Force
    }
} catch {
    if (Test-ExistingTaskForCurrentScript) {
        $startupMode = 'existing scheduled task'
    } else {
        New-MemGuardShortcut -Path $startupShortcutPath
        $startupMode = 'startup folder shortcut'
    }
}

$started = $false
if (-not $NoStart) {
    if (Test-MemGuardProcessForCurrentRoot) {
        Write-InstallMessage 'MemGuard is already running for this folder.'
    } else {
        Start-Process -FilePath $wscriptPath -ArgumentList "`"$startScript`"" -WindowStyle Hidden
        $started = $true
    }
}

Write-InstallMessage 'MemGuard installed.'
Write-InstallMessage "Startup mode: $startupMode"
Write-InstallMessage "Silent defaults: $configPath"
Write-InstallMessage "Desktop shortcut: $shortcutPath"
Write-InstallMessage "Launcher: $startScript"
Write-InstallMessage "Started now: $started"
