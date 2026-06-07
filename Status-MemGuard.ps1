$ErrorActionPreference = 'SilentlyContinue'

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$task = Get-ScheduledTask -TaskName 'MemGuard'
$info = Get-ScheduledTaskInfo -TaskName 'MemGuard'
$os = Get-CimInstance Win32_OperatingSystem
$usedPercent = [math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100, 1)
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$dataRoot = if ($env:MEMGUARD_USER_DATA_DIR) {
    Join-Path $env:MEMGUARD_USER_DATA_DIR 'data'
} else {
    Join-Path $env:APPDATA 'memguard\data'
}

Write-Host 'MemGuard'
Write-Host '--------'
if ($task) {
    Write-Host "Task state : $($task.State)"
    Write-Host "Last run   : $($info.LastRunTime)"
    Write-Host "Last result: $($info.LastTaskResult)"
} else {
    Write-Host 'Task state : Not installed'
}

Write-Host "Memory     : used ${usedPercent}% / free ${freeGB}GB / total ${totalGB}GB"
$configFile = Join-Path $dataRoot 'config.json'
if (Test-Path -LiteralPath $configFile) {
    Write-Host "Config     : $configFile"
}
$historyFile = Join-Path $dataRoot 'history.json'
if (Test-Path -LiteralPath $historyFile) {
    $history = Get-Content -LiteralPath $historyFile -Raw | ConvertFrom-Json
    $count = if ($history) { @($history).Count } else { 0 }
    Write-Host "History    : $count entries"
}
$widget = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -in @('electron.exe', 'MemGuard.exe') -and (
            ($_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))
        )
    } |
    Select-Object -First 1
if ($widget) {
    Write-Host "Process PID: $($widget.ProcessId)"
} else {
    Write-Host 'Process PID: not running'
}
Write-Host ''

$logDir = Join-Path $dataRoot 'logs'
$latest = Get-ChildItem -LiteralPath $logDir -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
    Write-Host "Latest log : $($latest.FullName)"
    Write-Host ''
    Get-Content -LiteralPath $latest.FullName -Tail 12
} else {
    Write-Host 'Latest log : none'
}
