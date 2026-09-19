@echo off
REM ============================================================
REM  SmartHR Enterprise - Dang ky giao thuc smarthr://
REM  Falcon EDR Safe 100%% - Chi ghi HKCU, khong can Admin
REM  QUAN TRONG: File nay BAT BUOC luu dang ASCII (khong dau).
REM  Khong luu UTF-8 co dau - cmd.exe se bao loi font.
REM  Duong dan OneDrive co dau & (vd Leggett & Platt) -> BAT BUOC
REM  dung Delayed Expansion (!VAR!) de ky tu dac biet an toan.
REM ============================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul
title SmartHR - Register smarthr protocol (Falcon EDR Safe)

echo ============================================================
echo   SmartHR Enterprise - Dang ky giao thuc smarthr://
echo   (Khong yeu cau quyen Admin, khong khoa cung ten User)
echo ============================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%start-server-hidden.vbs"

if not exist "%VBS_PATH%" (
    echo [LOI] Khong tim thay file start-server-hidden.vbs trong thu muc:
    echo "%SCRIPT_DIR%"
    echo.
    pause
    exit /b 1
)

echo Duong dan file kich hoat:
echo "%VBS_PATH%"
echo.
echo Dang dang ky giao thuc smarthr:// vao HKCU\Software\Classes...

reg add "HKCU\Software\Classes\smarthr" /ve /d "URL:SmartHR Server Launcher" /f >nul
reg add "HKCU\Software\Classes\smarthr" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\smarthr\shell" /f >nul
reg add "HKCU\Software\Classes\smarthr\shell\open" /f >nul
REM Dung !VBS_PATH! (Delayed Expansion) thay %VBS_PATH% de dau & trong
REM duong dan OneDrive (vd Leggett & Platt) khong bi cat lenh.
reg add "HKCU\Software\Classes\smarthr\shell\open\command" /ve /d "wscript.exe \"!VBS_PATH!\" \"%%1\"" /f >nul

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo   [THANH CONG] Da dang ky giao thuc smarthr:// thanh cong!
    echo ============================================================
    echo   - Nguoi dung: %USERNAME%
    echo   - Thu muc:    %SCRIPT_DIR%
    echo   - An toan:    Chi ghi vao HKCU (User Registry, 0 can thiep Admin)
    echo.
    echo Gia tri lenh da luu trong Registry (kiem tra duong dan day du):
    reg query "HKCU\Software\Classes\smarthr\shell\open\command" /ve
    echo.
    echo Bay gio ban co the bam nut "Kich Hoat Server" truc tiep tu
    echo muc Cai Dat tren trinh duyet Web ma khong can mo thu muc!
    echo.
) else (
    echo.
    echo [THAT BAI] Co loi khi them khoa Registry.
)

pause
