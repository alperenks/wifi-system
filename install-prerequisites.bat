@echo off
title Simülasyon Laboratuvarı - Gerekli Programların Kurulumu
echo ====================================================================
echo   Simülasyon Ortamı İçin Gerekli Windows Programları Kuruluyor...
echo ====================================================================
echo.
echo Bu işlem bilgisayarınıza aşağıdaki programları kuracaktır:
echo 1. Oracle VirtualBox (pfSense Sanal Makinesi İçin)
echo 2. Arduino IDE (ESP32 Kartına Yazılım Yüklemek İçin)
echo 3. WinSCP (pfSense'e Dosya Aktarmak İçin)
echo 4. PuTTY (pfSense Konsoluna SSH ile Bağlanmak İçin)
echo.
echo [ÖNEMLİ] Lütfen UAC (Kullanıcı Hesabı Denetimi) penceresi açıldığında
echo evet diyerek kuruluma onay veriniz.
echo.
pause

echo.
echo [1/4] Oracle VirtualBox kuruluyor...
winget install -e --id Oracle.VirtualBox --silent --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo [HATA] VirtualBox kurulumu başarısız oldu veya zaten kurulu.
) else (
    echo [OK] VirtualBox başarıyla kuruldu.
)

echo.
echo [2/4] Arduino IDE kuruluyor...
winget install -e --id ArduinoSA.IDE.stable --silent --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo [HATA] Arduino IDE kurulumu başarısız oldu veya zaten kurulu.
) else (
    echo [OK] Arduino IDE başarıyla kuruldu.
)

echo.
echo [3/4] WinSCP kuruluyor...
winget install -e --id WinSCP.WinSCP --silent --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo [HATA] WinSCP kurulumu başarısız oldu veya zaten kurulu.
) else (
    echo [OK] WinSCP başarıyla kuruldu.
)

echo.
echo [4/4] PuTTY kuruluyor...
winget install -e --id PuTTY.Putty --silent --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo [HATA] PuTTY kurulumu başarısız oldu veya zaten kurulu.
) else (
    echo [OK] PuTTY başarıyla kuruldu.
)

echo.
echo ====================================================================
echo   KURULUM TAMAMLANDI!
echo   Artık sanal makine ve donanım test adımlarına geçebilirsiniz.
echo ====================================================================
echo.
pause
