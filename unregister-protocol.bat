@echo off
chcp 65001 >nul
title Huy Dang Ky Giao Thuc SmartHR Protocol

echo ============================================================
echo   SmartHR Enterprise - Hủy Đăng Ký Giao Thức smarthr://
echo ============================================================
echo.

reg delete "HKCU\Software\Classes\smarthr" /f >nul 2>&1

if %errorlevel% equ 0 (
    echo [THÀNH CÔNG] Đã xóa giao thức smarthr:// khỏi máy tính của bạn.
) else (
    echo [THÔNG BÁO] Giao thức smarthr:// chưa từng được đăng ký hoặc đã bị xóa trước đó.
)

echo.
pause
