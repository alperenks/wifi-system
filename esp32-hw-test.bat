@echo off
REM ===========================================================================
REM  ESP32 Donanim Testi Calistiricisi
REM  KULLANIM:
REM   1. Laptopu "Restoran_Misafir_Wifi" agina baglan (ESP32'nin agi)
REM   2. Bu dosyaya cift tikla (veya terminalde calistir)
REM   3. Test biter, sonuc docs\esp32-hw-test-sonuc.txt dosyasina yazilir
REM   4. WiFi'i tekrar normal aginiza (KELES) baglayin
REM ===========================================================================
cd /d "%~dp0backend"
echo ESP32 donanim testi calisiyor (hedef 192.168.4.1)...
node esp32-hw-test.js 192.168.4.1 > "..\docs\esp32-hw-test-sonuc.txt" 2>&1
type "..\docs\esp32-hw-test-sonuc.txt"
echo.
echo === Sonuc docs\esp32-hw-test-sonuc.txt dosyasina kaydedildi ===
echo === Simdi WiFi'i normal aginiza geri baglayabilirsiniz ===
pause
