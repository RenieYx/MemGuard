Option Explicit

Dim shell, fso, appDir, packagedExe, sourceElectron, resourcesExe, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
packagedExe = fso.BuildPath(appDir, "MemGuard.exe")
sourceElectron = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")

resourcesExe = ""
If LCase(fso.GetFileName(appDir)) = "app" Then
    resourcesExe = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(appDir)), "MemGuard.exe")
End If

If fso.FileExists(packagedExe) Then
    shell.CurrentDirectory = appDir
    cmd = """" & packagedExe & """"
ElseIf fso.FileExists(sourceElectron) Then
    shell.CurrentDirectory = appDir
    cmd = """" & sourceElectron & """ """ & appDir & """"
ElseIf resourcesExe <> "" And fso.FileExists(resourcesExe) Then
    shell.CurrentDirectory = fso.GetParentFolderName(resourcesExe)
    cmd = """" & resourcesExe & """"
Else
    WScript.Quit 1
End If

shell.Run cmd, 0, False
