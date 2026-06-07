!macro customInstallMode
  StrCpy $isForceMachineInstall "0"
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customCheckAppRunning
  DetailPrint "Stopping existing MemGuard instance for this install path..."
  ${if} ${FileExists} "$INSTDIR\Stop-MemGuard.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Stop-MemGuard.ps1" -Root "$INSTDIR" -Quiet'
  ${else}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$root = ''$INSTDIR''; $$task = Get-ScheduledTask -TaskName ''MemGuard'' -ErrorAction SilentlyContinue; if ($$task -and (@($$task.Actions) | Where-Object { ($$_.Arguments -and $$_.Arguments.IndexOf($$root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($$_.WorkingDirectory -and $$_.WorkingDirectory.IndexOf($$root, [StringComparison]::OrdinalIgnoreCase) -ge 0) })) { Stop-ScheduledTask -TaskName ''MemGuard'' -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @(''MemGuard.exe'',''electron.exe'',''wscript.exe'') -and (($$_.CommandLine -like (''*'' + $$root + ''*'')) -or ($$_.ExecutablePath -like (''*'' + $$root + ''*''))) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  ${endIf}
  Pop $0
  ${if} $0 != 0
    DetailPrint "Existing MemGuard stop check returned exit code $0; continuing with installer file checks."
  ${endIf}
!macroend

!macro customInstall
  StrCpy $0 "$INSTDIR\resources\app\assets\memguard.ico"

  ${if} ${FileExists} "$0"
    ${if} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}

    ${if} ${FileExists} "$newStartMenuLink"
      Delete "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  ${endIf}

  ${if} ${FileExists} "$INSTDIR\Install-MemGuard.ps1"
    DetailPrint "Registering MemGuard startup task..."
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Install-MemGuard.ps1" -Quiet'
    Pop $0
    ${if} $0 != 0
      DetailPrint "MemGuard startup registration failed with exit code $0."
      Abort "MemGuard startup registration failed. Please rerun the installer or use Install-or-Repair.bat."
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${if} ${FileExists} "$INSTDIR\Uninstall-MemGuard.ps1"
    DetailPrint "Removing MemGuard startup task..."
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Uninstall-MemGuard.ps1" -Quiet'
    Pop $0
  ${endIf}
!macroend
