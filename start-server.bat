@echo off
title 5651 Captive Portal & RADIUS & Syslog Sunucusu
echo ====================================================================
echo   5651 Uyumlu SMS Dogrulamali Captive Portal Simülasyon Servisleri
echo ====================================================================
echo.
cd /d "%~dp0\backend"

echo [BILGI] Sunucular baslatiliyor...
echo [BILGI] http://localhost:3000/captive  adresinden giris ekranini test edebilirsiniz.
echo [BILGI] http://localhost:3000/dashboard adresinden kontrol panelini acabilirsiniz.
echo.

"C:\Program Files\nodejs\node.exe" server.js

if %errorlevel% neq 0 (
    echo.
    echo [HATA] Sunucu beklenmedik bir sekilde kapandi. Hata kodu: %errorlevel%
    pause
)
