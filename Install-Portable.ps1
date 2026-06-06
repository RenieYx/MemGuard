$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$startScript = Join-Path $root 'Start-MemGuard.vbs'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemGuard.lnk'
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'MemGuard.lnk'
$taskName = 'MemGuard'

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

function New-MemGuardShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $wscriptPath
    $shortcut.Arguments = "`"$startScript`""
    $shortcut.WorkingDirectory = $root
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

Start-Process -FilePath $wscriptPath -ArgumentList "`"$startScript`"" -WindowStyle Hidden

Write-Host "MemGuard installed."
Write-Host "Startup mode: $startupMode"
Write-Host "Desktop shortcut: $shortcutPath"
Write-Host "Launcher: $startScript"
