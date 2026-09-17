' ZenBot Silent Launcher (No visible console window)
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)

' Run start-zenbot.bat in hidden window (window style 0, do not wait for completion)
WshShell.Run "cmd.exe /c """ & ScriptDir & "\start-zenbot.bat""", 0, False
