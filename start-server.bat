@echo off
chcp 65001 >nul
title SmartHR - Standalone LAN Server (Falcon EDR Safe)

echo ============================================================
echo   SmartHR Enterprise - Standalone LAN Server
echo   Khoi dong voi Node.js Portable (Khong can cai dat)
echo ============================================================
echo.

set "NODE_BIN="

REM 1. Kiem tra node.exe trong cung thu muc
if exist "%~dp0node.exe" (
    set "NODE_BIN=%~dp0node.exe"
    goto :RUN
)

REM 2. Kiem tra node.exe trong thu muc con node hoac nodejs
if exist "%~dp0node\node.exe" (
    set "NODE_BIN=%~dp0node\node.exe"
    goto :RUN
)
if exist "%~dp0nodejs\node.exe" (
    set "NODE_BIN=%~dp0nodejs\node.exe"
    goto :RUN
)

REM 3. Kiem tra thu muc cha
if exist "%~dp0..\node.exe" (
    set "NODE_BIN=%~dp0..\node.exe"
    goto :RUN
)

REM 4. Kiem tra lenh node trong he thong
where node >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_BIN=node"
    goto :RUN
)

echo [LOI] Khong tim thay node.exe portable!
echo.
echo Cach khac phuc:
echo 1. Copy file node.exe (tu ban portable unzipped) vao cung thu muc nay: %~dp0
echo 2. Hoac de trong thu muc con: %~dp0node\node.exe
echo.
pause
exit /b 1

:RUN
echo Dang chay server bang: %NODE_BIN%
"%NODE_BIN%" "%~dp0server.js" %*

if %errorlevel% neq 0 (
    echo.
    echo Server da dung lai voi ma loi %errorlevel%.
    pause
)
