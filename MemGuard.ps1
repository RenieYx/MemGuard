param(
    [int]$TriggerPercent = 85,
    [int]$MinProcessMB = 180,
    [int]$CooldownMinutes = 20,
    [int]$CheckSeconds = 15,
    [int]$ConsecutiveHighChecks = 2,
    [int]$MaxLogMB = 1,
    [bool]$TrimOnStart = $true,
    [bool]$ShowWindow = $true
)

$ErrorActionPreference = 'Continue'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $appDir 'logs'
$stateFile = Join-Path $appDir 'last-trim.txt'
$logFile = Join-Path $logDir ("memguard-" + (Get-Date -Format 'yyyyMMdd') + ".log")
$mutex = New-Object System.Threading.Mutex($false, 'Global\MemGuard')

if (-not $mutex.WaitOne(0, $false)) {
    exit 0
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$nativeCode = @'
using System;
using System.Runtime.InteropServices;

public static class MemGuardNative
{
    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(IntPtr hProcess);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);
}

public class MemGuardForm : System.Windows.Forms.Form
{
    public MemGuardForm()
    {
        this.DoubleBuffered = true;
        this.SetStyle(
            System.Windows.Forms.ControlStyles.AllPaintingInWmPaint |
            System.Windows.Forms.ControlStyles.UserPaint |
            System.Windows.Forms.ControlStyles.OptimizedDoubleBuffer,
            true
        );
        this.UpdateStyles();
    }
}
'@
Add-Type -TypeDefinition $nativeCode -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

$script:highCount = 0
$script:isTrimming = $false
$script:snapshot = $null
$script:displayUsed = 0.0
$script:targetUsed = 0.0
$script:shimmer = 0.0
$script:hoverClean = $false
$script:pressClean = $false
$script:dragging = $false
$script:dragStart = [System.Drawing.Point]::Empty

function Write-MemGuardLog {
    param([string]$Message)

    if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt ($MaxLogMB * 1MB))) {
        $archive = Join-Path $logDir ("memguard-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log.old")
        Move-Item -LiteralPath $logFile -Destination $archive -Force
    }

    Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -Encoding UTF8
}

function Get-MemorySnapshot {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalKb = [double]$os.TotalVisibleMemorySize
    $freeKb = [double]$os.FreePhysicalMemory
    $usedPercent = [math]::Round((1 - ($freeKb / $totalKb)) * 100, 1)

    $lastTrim = $null
    if (Test-Path -LiteralPath $stateFile) {
        $raw = Get-Content -LiteralPath $stateFile -Raw
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse($raw, [ref]$parsed)) {
            $lastTrim = $parsed
        }
    }

    [pscustomobject]@{
        FreeGB = [math]::Round($freeKb / 1MB, 1)
        UsedPercent = $usedPercent
        LastTrim = $lastTrim
    }
}

function Get-LastTrimText {
    param([datetime]$LastTrim)

    if ($LastTrim -eq [datetime]::MinValue) {
        return '--'
    }

    $span = (Get-Date) - $LastTrim
    if ($span.TotalMinutes -lt 1) {
        return 'now'
    }
    if ($span.TotalHours -lt 1) {
        return ("{0} min ago" -f [math]::Floor($span.TotalMinutes))
    }
    return $LastTrim.ToString('HH:mm')
}

function Invoke-MemTrim {
    param([string]$Reason = 'manual')

    if ($script:isTrimming) {
        return
    }

    $script:isTrimming = $true
    if ($script:window) {
        $script:window.Invalidate()
    }

    try {
        $before = Get-MemorySnapshot
        Write-MemGuardLog "Trim start: reason=$Reason used=$($before.UsedPercent)% free=$($before.FreeGB)GB"

        $skipNames = @(
            'Idle', 'System', 'Registry', 'Memory Compression', 'Secure System',
            'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'dwm',
            'fontdrvhost', 'audiodg'
        )

        $trimmed = 0
        $currentPid = $PID
        $candidates = Get-Process |
            Where-Object {
                $_.Id -gt 4 -and
                $_.Id -ne $currentPid -and
                $_.WorkingSet64 -ge ($MinProcessMB * 1MB) -and
                $skipNames -notcontains $_.ProcessName
            } |
            Sort-Object WorkingSet64 -Descending |
            Select-Object -First 24

        foreach ($proc in $candidates) {
            try {
                if ($proc.Handle -ne [IntPtr]::Zero -and [MemGuardNative]::EmptyWorkingSet($proc.Handle)) {
                    $trimmed++
                }
            } catch {}
        }

        Start-Sleep -Milliseconds 800
        Set-Content -LiteralPath $stateFile -Value (Get-Date).ToString('o') -Encoding ASCII
        $after = Get-MemorySnapshot
        Write-MemGuardLog "Trim done: processes=$trimmed used=$($before.UsedPercent)%->$($after.UsedPercent)% free=$($before.FreeGB)GB->$($after.FreeGB)GB"
        Set-MemGuardSnapshot -Snapshot $after
    }
    finally {
        $script:isTrimming = $false
        if ($script:window) { $script:window.Invalidate() }
    }
}

function Set-MemGuardSnapshot {
    param([object]$Snapshot)

    $script:snapshot = $Snapshot
    $script:targetUsed = [math]::Max(0, [math]::Min(100, [double]$Snapshot.UsedPercent))
}

function New-RoundedPath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-MemGuardWindow {
    param(
        [System.Windows.Forms.Form]$Sender,
        [System.Windows.Forms.PaintEventArgs]$EventArgs
    )

    $g = $EventArgs.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $bounds = New-Object System.Drawing.RectangleF(0.5, 0.5, $Sender.Width - 1, $Sender.Height - 1)
    $path = New-RoundedPath -X $bounds.X -Y $bounds.Y -Width $bounds.Width -Height $bounds.Height -Radius 19
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bounds,
        [System.Drawing.Color]::FromArgb(255, 17, 24, 39),
        [System.Drawing.Color]::FromArgb(255, 15, 118, 110),
        22
    )
    $g.FillPath($brush, $path)
    $brush.Dispose()

    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(130, 94, 234, 212), 1)
    $g.DrawPath($borderPen, $path)
    $borderPen.Dispose()
    $path.Dispose()

    $percentFont = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $freeFont = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $smallFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $buttonFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 217, 249, 157))
    $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 223, 251, 255))

    $snapshot = $script:snapshot
    $freeText = if ($snapshot) { "{0:N1} GB free" -f $snapshot.FreeGB } else { '-- GB free' }
    $lastText = if ($snapshot -and $snapshot.LastTrim) { Get-LastTrimText -LastTrim $snapshot.LastTrim } else { '--' }

    $g.DrawString(("{0:N1}%" -f $script:displayUsed), $percentFont, $white, 14, 26)
    $g.DrawString($freeText, $freeFont, $green, 124, 18)
    $g.DrawString($lastText, $smallFont, $muted, 124, 34)

    $buttonX = 169
    $buttonY = 45
    $buttonPath = New-RoundedPath -X $buttonX -Y ($buttonY + $(if ($script:pressClean) { 1 } else { 0 })) -Width 45 -Height 20 -Radius 10
    $buttonAlpha = if ($script:isTrimming) { 150 } elseif ($script:hoverClean) { 132 } else { 92 }
    $buttonBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($buttonAlpha, 20, 83, 45))
    $buttonPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 217, 249, 157), 1)
    $g.FillPath($buttonBrush, $buttonPath)
    $g.DrawPath($buttonPen, $buttonPath)
    $buttonText = if ($script:isTrimming) { '...' } else { 'Clean' }
    $buttonFormat = New-Object System.Drawing.StringFormat
    $buttonFormat.Alignment = [System.Drawing.StringAlignment]::Center
    $buttonFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
    $buttonRect = New-Object System.Drawing.RectangleF($buttonX, ($buttonY + $(if ($script:pressClean) { 1 } else { 0 })), 45, 20)
    $g.DrawString($buttonText, $buttonFont, $green, $buttonRect, $buttonFormat)
    $buttonFormat.Dispose()
    $buttonBrush.Dispose()
    $buttonPen.Dispose()
    $buttonPath.Dispose()

    $barX = 14
    $barY = 71
    $barWidth = 190
    $barHeight = 5
    $backPath = New-RoundedPath -X $barX -Y $barY -Width $barWidth -Height $barHeight -Radius 2.5
    $backBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(52, 207, 250, 254))
    $g.FillPath($backBrush, $backPath)
    $backBrush.Dispose()
    $backPath.Dispose()

    $fillWidth = [math]::Max(0, [math]::Min($barWidth, $barWidth * ($script:displayUsed / 100.0)))
    if ($fillWidth -gt 1) {
        $fillPath = New-RoundedPath -X $barX -Y $barY -Width $fillWidth -Height $barHeight -Radius 2.5
        $fillRect = New-Object System.Drawing.RectangleF($barX, $barY, $barWidth, $barHeight)
        $fillBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $fillRect,
            [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
            [System.Drawing.Color]::FromArgb(255, 163, 230, 53),
            0
        )
        $g.FillPath($fillBrush, $fillPath)

        $clip = $g.Clip
        $g.SetClip($fillPath)
        $sweepWidth = if ($script:isTrimming) { 44 } else { 30 }
        $sweepWidth = [math]::Min($sweepWidth, [math]::Max(12, $fillWidth))
        $sweepX = $barX - $sweepWidth + (($script:shimmer % 1.0) * ($fillWidth + $sweepWidth))
        $sweepRect = New-Object System.Drawing.RectangleF($sweepX, $barY - 1, $sweepWidth, $barHeight + 2)
        $sweepBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $sweepRect,
            [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
            [System.Drawing.Color]::FromArgb($(if ($script:isTrimming) { 190 } else { 82 }), 255, 255, 255),
            0
        )
        $g.FillRectangle($sweepBrush, $sweepRect)
        $sweepBrush.Dispose()
        $g.Clip = $clip
        $clip.Dispose()
        $fillBrush.Dispose()
        $fillPath.Dispose()
    }

    $white.Dispose()
    $green.Dispose()
    $muted.Dispose()
    $percentFont.Dispose()
    $freeFont.Dispose()
    $smallFont.Dispose()
    $buttonFont.Dispose()
}

function Test-CooldownReady {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $true }
    $raw = Get-Content -LiteralPath $stateFile -Raw
    $last = [datetime]::MinValue
    if (-not [datetime]::TryParse($raw, [ref]$last)) { return $true }
    return ((Get-Date) - $last).TotalMinutes -ge $CooldownMinutes
}

function Invoke-MonitorTick {
    $snapshot = Get-MemorySnapshot
    Set-MemGuardSnapshot -Snapshot $snapshot

    if ($snapshot.UsedPercent -ge $TriggerPercent) {
        $script:highCount++
    } else {
        $script:highCount = 0
    }

    if ($script:highCount -ge $ConsecutiveHighChecks -and (Test-CooldownReady)) {
        Invoke-MemTrim -Reason 'auto'
        $script:highCount = 0
    }
}

function New-MemGuardWindow {
    [System.Windows.Forms.Application]::EnableVisualStyles()
    [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

    $window = New-Object MemGuardForm
    $window.Text = 'MemGuard'
    $window.Width = 218
    $window.Height = 82
    $window.FormBorderStyle = 'None'
    $window.StartPosition = 'Manual'
    $window.TopMost = $false
    $window.ShowInTaskbar = $false
    $window.BackColor = [System.Drawing.Color]::FromArgb(17, 24, 39)
    $window.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $regionHandle = [MemGuardNative]::CreateRoundRectRgn(0, 0, $window.Width + 1, $window.Height + 1, 38, 38)
    $window.Region = [System.Drawing.Region]::FromHrgn($regionHandle)
    [MemGuardNative]::DeleteObject($regionHandle) | Out-Null

    $window.Add_Paint({ Draw-MemGuardWindow -Sender $this -EventArgs $_ })
    $window.Add_DoubleClick({ Invoke-MemTrim -Reason 'manual' })
    $window.Add_MouseDown({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $cleanBounds = New-Object System.Drawing.Rectangle(169, 45, 45, 20)
            if ($cleanBounds.Contains($_.Location)) {
                $script:pressClean = $true
                $this.Invalidate()
                return
            }
            $script:dragging = $true
            $script:dragStart = $_.Location
        }
    })
    $window.Add_MouseMove({
        $cleanBounds = New-Object System.Drawing.Rectangle(169, 45, 45, 20)
        $script:hoverClean = $cleanBounds.Contains($_.Location)
        if ($script:dragging) {
            $this.Left += $_.X - $script:dragStart.X
            $this.Top += $_.Y - $script:dragStart.Y
        }
        $this.Invalidate()
    })
    $window.Add_MouseLeave({
        $script:hoverClean = $false
        $script:pressClean = $false
        $this.Invalidate()
    })
    $window.Add_MouseUp({
        $cleanBounds = New-Object System.Drawing.Rectangle(169, 45, 45, 20)
        $clickedClean = $script:pressClean -and $cleanBounds.Contains($_.Location)
        $script:dragging = $false
        $script:pressClean = $false
        $this.Invalidate()
        if ($clickedClean) {
            Invoke-MemTrim -Reason 'manual'
        }
    })

    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $window.Left = $workArea.Right - $window.Width - 18
    $window.Top = $workArea.Top + 18
    $script:window = $window

    return $window
}

Write-MemGuardLog "Started native UI: trigger=${TriggerPercent}% minProcess=${MinProcessMB}MB cooldown=${CooldownMinutes}min check=${CheckSeconds}s"

try {
    if ($TrimOnStart) {
        Invoke-MemTrim -Reason 'startup'
    }

    if ($ShowWindow) {
        $window = New-MemGuardWindow
        Set-MemGuardSnapshot -Snapshot (Get-MemorySnapshot)
        $script:displayUsed = $script:targetUsed

        $refreshTimer = New-Object System.Windows.Forms.Timer
        $refreshTimer.Interval = $CheckSeconds * 1000
        $refreshTimer.Add_Tick({ Invoke-MonitorTick })
        $refreshTimer.Start()

        $animationTimer = New-Object System.Windows.Forms.Timer
        $animationTimer.Interval = 16
        $animationTimer.Add_Tick({
            $diff = $script:targetUsed - $script:displayUsed
            if ([math]::Abs($diff) -lt 0.02) {
                $script:displayUsed = $script:targetUsed
            } else {
                $script:displayUsed += $diff * 0.12
            }
            $step = if ($script:isTrimming) { 0.045 } else { 0.012 }
            $script:shimmer = ($script:shimmer + $step) % 1.0
            if ($script:window) { $script:window.Invalidate() }
        })
        $animationTimer.Start()

        [System.Windows.Forms.Application]::Run($window)
    } else {
        while ($true) {
            Invoke-MonitorTick
            Start-Sleep -Seconds $CheckSeconds
        }
    }
}
catch {
    Write-MemGuardLog "ERROR fatal: $($_.Exception.Message)"
}
finally {
    if ($mutex) {
        $mutex.ReleaseMutex() | Out-Null
        $mutex.Dispose()
    }
}
