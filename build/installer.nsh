!macro customInit
  DetailPrint "Preparing MemGuard upgrade..."
  ${if} ${FileExists} "$INSTDIR\Stop-MemGuard.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Stop-MemGuard.ps1" -Root "$INSTDIR" -Quiet'
  ${else}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName ''MemGuard'' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @(''MemGuard.exe'',''electron.exe'',''wscript.exe'') -and (($$_.CommandLine -like ''*MemGuard*'') -or ($$_.ExecutablePath -like ''*MemGuard*'')) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
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
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Install-MemGuard.ps1"'
  ${endIf}
!macroend

!macro customUnInstall
  ${if} ${FileExists} "$INSTDIR\Uninstall-MemGuard.ps1"
    DetailPrint "Removing MemGuard startup task..."
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Uninstall-MemGuard.ps1"'
  ${endIf}
!macroend
