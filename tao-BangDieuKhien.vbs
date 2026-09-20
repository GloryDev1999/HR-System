' ============================================================
'   SmartHR - Tao shortcut Bang Dieu Khien (1 click)
'   Double-click file nay 1 lan tren may Hoa:
'     1. Tao SmartHR-BangDieuKhien.lnk NGAY TRONG THU MUC NAY
'        (de nhin thay lien, khong phai tim)
'     2. Tao them 1 ban tren Desktop
'   Click .lnk = wscript mo-ui.vbs
'        = node launcher-ui.js an + mo browser 127.0.0.1:4179
'
'   Falcon-safe: chi WScript.Shell + FileSystemObject.
'   Khong PowerShell, khong Bypass, khong Registry,
'   khong Admin/HKLM, khong tai file ngoai.
'   (File .vbs giu ASCII khong dau de tranh loi font cmd/cscript.
'   MsgBox duy nhat nay nam o script cai dat Windows 1 lan,
'   khong phai dialog trong app browser.)
' ============================================================

Option Explicit
On Error Resume Next

Dim WshShell, fso, strPath, moPath, iconPath
Dim lnkHere, lnkDesk, madeHere, madeDesk, msg
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
moPath = strPath & "\mo-ui.vbs"

If Err.Number <> 0 Then
  MsgBox "Loi khoi tao Windows Script Host: " & Err.Description, 16, "SmartHR"
  WScript.Quit 1
End If

If Not fso.FileExists(moPath) Then
  MsgBox "Khong tim thay mo-ui.vbs trong:" & vbCrLf & strPath & vbCrLf & _
         "Hay dat file nay chung thu muc voi mo-ui.vbs roi chay lai.", 16, "SmartHR"
  WScript.Quit 1
End If

iconPath = strPath & "\public\hr-manager.ico"
If Not fso.FileExists(iconPath) Then iconPath = strPath & "\public\favicon.ico"
If Not fso.FileExists(iconPath) Then iconPath = ""

lnkHere = strPath & "\SmartHR-BangDieuKhien.lnk"
Call MakeShortcut(lnkHere)
madeHere = fso.FileExists(lnkHere)

lnkDesk = WshShell.SpecialFolders("Desktop") & "\SmartHR-BangDieuKhien.lnk"
Call MakeShortcut(lnkDesk)
madeDesk = fso.FileExists(lnkDesk)

Set fso = Nothing
Set WshShell = Nothing

If madeHere Or madeDesk Then
  msg = "Da tao xong Bang Dieu Khien SmartHR." & vbCrLf & vbCrLf
  If madeHere Then msg = msg & "[OK] Trong thu muc hien tai:" & vbCrLf & lnkHere & vbCrLf & vbCrLf
  If madeDesk Then msg = msg & "[OK] Tren Desktop:" & vbCrLf & lnkDesk & vbCrLf & vbCrLf
  If Not madeDesk Then msg = msg & "[CHU Y] Khong tao duoc tren Desktop." & vbCrLf & _
    "Hay chuot phai file .lnk trong thu muc -> Send to -> Desktop." & vbCrLf & vbCrLf
  msg = msg & "Tu nay chi can click bieu tuong do de mo bang dieu khien cong 4173." & vbCrLf
  If iconPath <> "" Then msg = msg & "Icon: " & iconPath & vbCrLf
  msg = msg & "Neu icon chua len ngay: ra Desktop bam F5 (Refresh) 1-2 lan." & vbCrLf & vbCrLf
  msg = msg & "[QUAN TRONG - MOI MAY CHAY 1 LAN] File .lnk chua duong dan TUYET DOI" & vbCrLf & _
    "cua chinh may nay, nen Hoa/Glory/Kieu moi nguoi tu chay file nay 1 lan" & vbCrLf & _
    "TREN MAY CUA MINH. Dung mo truc tiep ban .lnk trong thu muc chung do" & vbCrLf & _
    "may khac tao (no se tro sai duong dan). Ban trong thu muc chi de" & vbCrLf & _
    "chuot phai -> Send to -> Desktop."
  MsgBox msg, 64, "SmartHR"
Else
  MsgBox "KHONG tao duoc shortcut." & vbCrLf & _
         "Nguyen nhan thuong gap: khong co quyen ghi thu muc." & vbCrLf & _
         "Hay copy ca thu muc ra cho khac (vd Documents) roi chay lai.", 16, "SmartHR"
End If

Sub MakeShortcut(lnkPath)
  On Error Resume Next
  Dim oLink
  ' Windows cache icon theo duong dan file: phai XOA ban .lnk cu truoc
  ' roi moi tao moi thi icon HR moi chiu hien (ghi de tai cho khong doi icon).
  If fso.FileExists(lnkPath) Then fso.DeleteFile lnkPath, True
  Set oLink = WshShell.CreateShortcut(lnkPath)
  oLink.TargetPath = "wscript.exe"
  oLink.Arguments = """" & moPath & """"
  oLink.WorkingDirectory = strPath
  oLink.Description = "SmartHR - Trung tam dieu khien cong 4173"
  oLink.WindowStyle = 1
  If iconPath <> "" Then oLink.IconLocation = iconPath & ",0"
  oLink.Save
  Set oLink = Nothing
End Sub
