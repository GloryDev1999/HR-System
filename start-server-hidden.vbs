' ============================================================
'   SmartHR Enterprise - Khoi Dong Server Chay Ngam (Silent)
'   Toi uu hoa cho Falcon EDR & Node.js Portable
'   Hoan toan AN CUA SO CMD (Khong gay giat man hinh)
' ============================================================

Option Explicit
Dim WshShell, fso, strPath, nodeCmd

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Uu tien tim node.exe trong thu muc hien tai hoac thu muc con
If fso.FileExists(strPath & "\node.exe") Then
    nodeCmd = """" & strPath & "\node.exe"""
ElseIf fso.FileExists(strPath & "\node\node.exe") Then
    nodeCmd = """" & strPath & "\node\node.exe"""
ElseIf fso.FileExists(strPath & "\nodejs\node.exe") Then
    nodeCmd = """" & strPath & "\nodejs\node.exe"""
ElseIf fso.FileExists(strPath & "\..\node.exe") Then
    nodeCmd = """" & strPath & "\..\node.exe"""
Else
    nodeCmd = "node"
End If

' 2. Chay server.js voi windowStyle = 0 (An hoan toan cua so cmd/console)
'    bWaitOnReturn = False (Khong dong bang script)
WshShell.Run nodeCmd & " """ & strPath & "\server.js""", 0, False

Set WshShell = Nothing
Set fso = Nothing
