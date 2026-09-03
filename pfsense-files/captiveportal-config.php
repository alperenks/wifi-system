<?php
// ====================================================================
// pfSense Captive Portal & NetGSM SMS Doğrulama Konfigürasyonu (captiveportal-config.php)
// ====================================================================

// 1. Veritabanı Bağlantı Ayarları (pfSense Yerel MySQL Sunucusu)
define("DB_HOST", "localhost");
define("DB_USER", "root");
define("DB_PASS", "sifreniz"); // mysql_secure_installation ile belirlediğiniz root şifresi
define("DB_NAME", "radius");

// 2. NetGSM SMS API Entegrasyon Ayarları
define("NETGSM_USER", "netgsm_kullanici_adiniz"); 
define("NETGSM_PASS", "netgsm_sifreniz");
define("NETGSM_HEADER", "RESTORAN_ADI"); // NetGSM'den onaylı SMS başlığınız (Header)

// 3. Misafir Kullanıcı Ağ Hız ve Süre Limitleri
// Hız limitleri bit/s (bps) cinsindendir. Örn: 5242880 = 5 Mbps, 2097152 = 2 Mbps
define("RATE_LIMIT_DOWN", "5242880"); // 5 Mbps Download
define("RATE_LIMIT_UP", "2097152");   // 2 Mbps Upload
define("SESSION_TIMEOUT", "7200");    // 2 Saat (Saniye cinsinden: 7200s)

// 4. Simülasyon Modu Ayarı
// Eğer true ise, NetGSM API'sine istek atmak yerine OTP kodunu pfSense PHP loglarına yazar.
// Bu sayede SMS bakiyeniz gitmez ve internet olmadan da doğrulama testleri yapabilirsiniz.
define("SIMULATION_MODE", true); 
?>
