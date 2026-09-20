' ============================================================
'   SmartHR - Mo Bang Dieu Khien Web (khong cua so den)
'   1. Start node launcher-ui.js an hoan toan (windowStyle 0)
'   2. Mo trinh duyet toi http://127.0.0.1:4179
'   Falcon-safe: wscript + node signed, khong Bypass/Encode.
' ============================================================

Option Explicit
Dim WshShell, fso, strPath, nodeCmd, mgrUrl
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
mgrUrl = "http://127.0.0.1:4179"

If fso.FileExists(strPath & "\node.exe") Then
    nodeCmd = """" & strPath & "\node.exe"""
ElseIf fso.FileExists(strPath & "\node\node.exe") Then
    nodeCmd = """" & strPath & "\node\node.exe"""
ElseIf fso.FileExists(strPath & "\nodejs\node.exe") Then
    nodeCmd = """" & strPath & "\nodejs\node.exe"""
Else
    nodeCmd = "node"
End If

' 1. Chay manager an (0 = hidden, False = khong doi)
WshShell.Run nodeCmd & " """ & strPath & "\launcher-ui.js""", 0, False

' 2. Doi manager khoi dong roi mo trinh duyet
WScript.Sleep 2500
WshShell.Run mgrUrl, 1, False

Set WshShell = Nothing
Set fso = Nothing
