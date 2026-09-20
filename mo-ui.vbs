' ============================================================
'   SmartHR - Mo Bang Dieu Khien Web (khong cua so den)
'   1. Hoi trung tam 127.0.0.1:4179/api/status truoc:
'      - Dang chay roi -> KHONG mo them (chong nhan doi tien trinh),
'        chi mo trinh duyet.
'      - Chua chay -> start node launcher-ui.js an hoan toan (windowStyle 0)
'   2. Mo trinh duyet toi http://127.0.0.1:4179
'   Falcon-safe: wscript + node signed, khong Bypass/Encode.
' ============================================================

Option Explicit
Dim WshShell, fso, strPath, nodeCmd, mgrUrl, http, alive
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
mgrUrl = "http://127.0.0.1:4179"
alive = False

' 0. Trung tam dang chay san thi thoi, khoi spawn them.
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
If Err.Number = 0 Then
  http.open "GET", mgrUrl & "/api/status", False
  http.setTimeouts 1000, 1000, 1000, 2000
  http.send
  If Err.Number = 0 And http.Status = 200 Then alive = True
  Set http = Nothing
End If
On Error GoTo 0

If fso.FileExists(strPath & "\node.exe") Then
    nodeCmd = """" & strPath & "\node.exe"""
ElseIf fso.FileExists(strPath & "\node\node.exe") Then
    nodeCmd = """" & strPath & "\node\node.exe"""
ElseIf fso.FileExists(strPath & "\nodejs\node.exe") Then
    nodeCmd = """" & strPath & "\nodejs\node.exe"""
Else
    nodeCmd = "node"
End If

' 1. Chay manager an (0 = hidden, False = khong doi) - chi khi chua chay.
If Not alive Then
  WshShell.Run nodeCmd & " """ & strPath & "\launcher-ui.js""", 0, False

  ' 2. Doi manager khoi dong roi mo trinh duyet
  WScript.Sleep 2500
End If
WshShell.Run mgrUrl, 1, False

Set WshShell = Nothing
Set fso = Nothing
