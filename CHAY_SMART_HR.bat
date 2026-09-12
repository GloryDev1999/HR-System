@echo off
chcp 65001 >nul
title SMART HR - Leggett & Platt
echo ========================================================================
echo   SMART HR - HE THONG QUAN TRI NHAN SU ^& CHAM CONG (LOCAL CLUSTER)
echo ========================================================================
echo.
set PORT=3000

:: Xac dinh thu muc chua file index.html
set TARGET_DIR=%~dp0
if exist "%TARGET_DIR%dist\index.html" (
    set SERVE_DIR=%TARGET_DIR%dist
) else if exist "%TARGET_DIR%index.html" (
    set SERVE_DIR=%TARGET_DIR%
) else (
    echo [LOI] Khong tim thay file index.html!
    pause
    exit /b 1
)

echo [1/2] Dang khoi tao may chu cuc bo tai: http://localhost:%PORT%/
echo [2/2] Dang mo trinh duyet Microsoft Edge...
echo.
echo ========================================================================
echo   Luu y: KHONG DONG cua so nay trong khi dang lam viec voi SMART HR.
echo   Trinh duyet Edge gio day da duoc mo khoa day du API Chon Thu Muc!
echo ========================================================================
echo.

:: Mo trinh duyet Edge tai dia chi localhost
start "" "http://localhost:%PORT%/"

:: Khoi chay may chu bang PowerShell san co cua Windows (Khong can cai dat Node/Python)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = %PORT%;" ^
  "$serveDir = '%SERVE_DIR%'.TrimEnd('\');" ^
  "$listener = New-Object System.Net.HttpListener;" ^
  "$listener.Prefixes.Add(\"http://localhost:$port/\");" ^
  "try { $listener.Start(); } catch { Write-Host '[THONG BAO] Port $port da duoc su dung hoac server da chay tu truoc.'; pause; exit; }" ^
  "Write-Host \"[DA SAN SANG] Server dang lang nghe tai http://localhost:$port/\";" ^
  "while ($listener.IsListening) {" ^
  "  try {" ^
  "    $context = $listener.GetContext();" ^
  "    $req = $context.Request;" ^
  "    $res = $context.Response;" ^
  "    $rawUrl = $req.RawUrl.Split('?')[0];" ^
  "    if ($rawUrl -eq '/' -or $rawUrl -eq '') { $subPath = 'index.html'; } else { $subPath = $rawUrl.TrimStart('/'); }" ^
  "    $filePath = Join-Path $serveDir $subPath;" ^
  "    if (-not (Test-Path $filePath -PathType Leaf)) { $filePath = Join-Path $serveDir 'index.html'; }" ^
  "    if (Test-Path $filePath -PathType Leaf) {" ^
  "      $bytes = [System.IO.File]::ReadAllBytes($filePath);" ^
  "      $ext = [System.IO.Path]::GetExtension($filePath).ToLower();" ^
  "      switch ($ext) {" ^
  "        '.html' { $res.ContentType = 'text/html; charset=utf-8' }" ^
  "        '.js'   { $res.ContentType = 'application/javascript' }" ^
  "        '.css'  { $res.ContentType = 'text/css' }" ^
  "        '.wasm' { $res.ContentType = 'application/wasm' }" ^
  "        '.json' { $res.ContentType = 'application/json' }" ^
  "        '.png'  { $res.ContentType = 'image/png' }" ^
  "        '.jpg'  { $res.ContentType = 'image/jpeg' }" ^
  "        default { $res.ContentType = 'application/octet-stream' }" ^
  "      }" ^
  "      $res.ContentLength64 = $bytes.Length;" ^
  "      $res.OutputStream.Write($bytes, 0, $bytes.Length);" ^
  "    } else {" ^
  "      $res.StatusCode = 404;" ^
  "    }" ^
  "    $res.OutputStream.Close();" ^
  "  } catch {}" ^
  "}"
