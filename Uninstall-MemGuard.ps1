$ErrorActionPreference = 'SilentlyContinue'

$taskName = 'MemGuard'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Stop-ScheduledTask -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -in @('electron.exe', 'MemGuard.exe') -and (
            ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))
        )
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemGuard.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'MemGuard.lnk'
if (Test-Path -LiteralPath $startupShortcutPath) {
    Remove-Item -LiteralPath $startupShortcutPath -Force
}

Write-Host "MemGuard uninstalled."
