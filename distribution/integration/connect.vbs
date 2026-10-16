Option Explicit
Dim maidShell, maidFiles, maidScript, maidCommand
Set maidShell = CreateObject("WScript.Shell")
Set maidFiles = CreateObject("Scripting.FileSystemObject")
maidScript = maidFiles.BuildPath(maidFiles.GetParentFolderName(WScript.ScriptFullName), "connect.ps1")
maidCommand = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & maidScript & Chr(34)
If WScript.Arguments.Count > 0 Then
    If WScript.Arguments.Count <> 1 Then WScript.Quit 1
    If LCase(WScript.Arguments(0)) <> "--remove" Then WScript.Quit 1
    maidCommand = maidCommand & " -Remove"
End If
maidShell.Run maidCommand, 0, False
