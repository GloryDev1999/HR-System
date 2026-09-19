@echo off
REM ============================================================
REM  SmartHR Enterprise - Huy dang ky giao thuc smarthr://
REM  Falcon EDR Safe - Chi xoa HKCU, khong can Admin
REM  File luu dang ASCII (khong dau) de tranh loi font cmd.exe
REM ============================================================
chcp 65001 >nul
title SmartHR - Unregister smarthr protocol

echo ============================================================
echo   SmartHR Enterprise - Huy dang ky giao thuc smarthr://
echo ============================================================
echo.

reg delete "HKCU\Software\Classes\smarthr" /f >nul 2>&1

if %errorlevel% equ 0 (
    echo [THANH CONG] Da xoa giao thuc smarthr:// khoi may cua ban.
) else (
    echo [THONG BAO] Giao thuc smarthr:// chua tung duoc dang ky hoac da bi xoa truoc do.
)

echo.
pause
