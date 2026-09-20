' ============================================================
'   SmartHR - Tao shortcut Bang Dieu Khien tren Desktop (1 click)
'   Chay file nay 1 lan tren may Hoa (double-click):
'     -> tao SmartHR-BangDieuKhien.lnk tren Desktop
'     -> click .lnk = wscript mo-ui.vbs
'        = node launcher-ui.js an + mo browser 127.0.0.1:4179
'
'   Falcon-safe: chi WScript.Shell + FileSystemObject.
'   Khong PowerShell, khong Bypass, khong Registry,
'   khong Admin/HKLM, khong tai file ngoai.
'   (MsgBox duy nhat nay nam o script cai dat Windows 1 lan,
'   khong phai dialog trong app browser.)
' ============================================================

Option Explicit
Dim WshShell, fso, strPath, lnkPath, oLink, iconPath
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' Icon that su dung public\favicon.ico (file .ico duy nhat co that
' trong repo; public\hr-manager.ico duoc nhac trong pipeline.md
' hien chua ton tai nen khong dung de tranh mat icon).
iconPath = strPath & "\public\favicon.ico"
If Not fso.FileExists(iconPath) Then iconPath = ""

lnkPath = WshShell.SpecialFolders("Desktop") & "\SmartHR-BangDieuKhien.lnk"
Set oLink = WshShell.CreateShortcut(lnkPath)
oLink.TargetPath = "wscript.exe"
oLink.Arguments = """" & strPath & "\mo-ui.vbs"""
oLink.WorkingDirectory = strPath
oLink.Description = "SmartHR - Trung tam dieu khien cong 4173"
oLink.WindowStyle = 1
If iconPath <> "" Then oLink.IconLocation = iconPath
oLink.Save

Set oLink = Nothing
Set fso = Nothing
Set WshShell = Nothing

MsgBox "Da tao SmartHR-BangDieuKhien tren Desktop." & vbCrLf & _
       "Tu nay chi can click bieu tuong do de mo bang dieu khien cong 4173.", _
       64, "SmartHR"
