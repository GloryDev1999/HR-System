@echo off
chcp 65001 >nul
title Dang Ky Giao Thuc SmartHR Protocol (Falcon EDR Safe)

echo ============================================================
echo   SmartHR Enterprise - Đăng Ký Giao Thức smarthr://
echo   (Không yêu cầu quyền Admin, không khóa cứng tên User)
echo ============================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%start-server-hidden.vbs"

if not exist "%VBS_PATH%" (
    echo [LỖI] Không tìm thấy file start-server-hidden.vbs trong thư mục:
    echo "%SCRIPT_DIR%"
    echo.
    pause
    exit /b 1
)

echo Đường dẫn file kích hoạt:
echo "%VBS_PATH%"
echo.
echo Đang đăng ký giao thức smarthr:// vào HKCU\Software\Classes...

reg add "HKCU\Software\Classes\smarthr" /ve /d "URL:SmartHR Server Launcher" /f >nul
reg add "HKCU\Software\Classes\smarthr" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\smarthr\shell" /f >nul
reg add "HKCU\Software\Classes\smarthr\shell\open" /f >nul
reg add "HKCU\Software\Classes\smarthr\shell\open\command" /ve /d "wscript.exe \"%VBS_PATH%\" \"%%1\"" /f >nul

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo   [THÀNH CÔNG] Đã đăng ký giao thức smarthr:// thành công!
    echo ============================================================
    echo   - Người dùng: %USERNAME%
    echo   - Thư mục:    %SCRIPT_DIR%
    echo   - An toàn:    Chỉ ghi vào HKCU (User Registry, 0 can thiệp Admin)
    echo.
    echo Bây giờ anh có thể bấm nút "Mở Server" trực tiếp từ
    echo mục Cài Đặt trên trình duyệt Web mà không cần mở thư mục!
    echo.
) else (
    echo.
    echo [THẤT BẠI] Có lỗi khi thêm khóa Registry.
)

pause
