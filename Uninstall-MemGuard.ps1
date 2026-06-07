param(
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$stopScript = Join-Path $root 'Stop-MemGuard.ps1'

if (Test-Path -LiteralPath $stopScript -PathType Leaf) {
    & $stopScript -Root $root -UnregisterTask -Quiet:$Quiet
} else {
    $taskName = 'MemGuard'
    Stop-ScheduledTask -TaskName $taskName | Out-Null
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null

    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -in @('electron.exe', 'MemGuard.exe', 'wscript.exe') -and (
                ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))
            )
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemGuard.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'MemGuard.lnk'
if (Test-Path -LiteralPath $startupShortcutPath) {
    Remove-Item -LiteralPath $startupShortcutPath -Force
}

if (-not $Quiet) {
    Write-Host 'MemGuard uninstalled.'
}
