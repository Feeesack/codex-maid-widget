Option Explicit
Dim maidShell, maidFiles, maidScript, maidCommand
Set maidShell = CreateObject("WScript.Shell")
Set maidFiles = CreateObject("Scripting.FileSystemObject")
maidScript = maidFiles.BuildPath(maidFiles.GetParentFolderName(WScript.ScriptFullName), "connect.ps1")
maidCommand = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & maidScript & Chr(34)
maidShell.Run maidCommand, 0, False
