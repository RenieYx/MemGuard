param(
    [string]$Root = $PSScriptRoot,
    [switch]$UnregisterTask,
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

try {
    $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
} catch {
    $resolvedRoot = $Root
}

$taskName = 'MemGuard'
Stop-ScheduledTask -TaskName $taskName | Out-Null
if ($UnregisterTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
}

$pathNeedles = @(
    $resolvedRoot,
    (Join-Path $resolvedRoot 'resources\app'),
    (Join-Path $resolvedRoot 'Start-MemGuard.vbs')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

function Test-MemGuardProcess {
    param([object]$Process)

    if ($Process.Name -notin @('MemGuard.exe', 'electron.exe', 'wscript.exe')) {
        return $false
    }

    $haystack = @(
        [string]$Process.CommandLine,
        [string]$Process.ExecutablePath
    ) -join "`n"

    foreach ($needle in $pathNeedles) {
        if ($haystack.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }

    return $false
}

$targets = @(Get-CimInstance Win32_Process | Where-Object { Test-MemGuardProcess $_ })

foreach ($target in $targets) {
    try {
        $proc = Get-Process -Id $target.ProcessId -ErrorAction Stop
        if ($proc.MainWindowHandle -ne 0) {
            [void]$proc.CloseMainWindow()
            Start-Sleep -Milliseconds 700
        }
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        }
        if (-not $Quiet) {
            Write-Host "Stopped $($target.Name) PID $($target.ProcessId)"
        }
    } catch {
        if (-not $Quiet) {
            Write-Host "Could not stop $($target.Name) PID $($target.ProcessId): $($_.Exception.Message)"
        }
    }
}

if (-not $Quiet) {
    Write-Host "MemGuard stopped for root: $resolvedRoot"
}
