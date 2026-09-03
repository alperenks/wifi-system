<?php
// ====================================================================
// pfSense Captive Portal SMS OTP Kontrolcü Scripti (captiveportal-sms.php)
// ====================================================================

// Hataları ve uyarıları loglara yaz ama ekrana basma (JSON bozulmasın)
ini_set('display_errors', 0);
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');

// Konfigürasyon dosyasını dahil et
require_once('captiveportal-config.php');

$action = isset($_GET['action']) ? $_GET['action'] : '';

// Veritabanı Bağlantısı
$conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
if ($conn->connect_error) {
    echo json_encode([
        "success" => false,
        "message" => "Veritabanı bağlantı hatası: " . $conn->connect_error
    ]);
    exit;
}
$conn->set_charset("utf8mb4");

// --- API Eylemleri ---

if ($action === 'send_otp') {
    // POST verilerini al
    $input = json_decode(file_get_contents('php://input'), true);
    $mac = isset($input['mac']) ? cleanMac($input['mac']) : '';
    $phone = isset($input['phone']) ? preg_replace('/[^0-9]/', '', $input['phone']) : '';

    if (empty($mac) || empty($phone) || strlen($phone) !== 10 || $phone[0] !== '5') {
        echo json_encode(["success" => false, "message" => "Geçersiz telefon numarası veya MAC adresi."]);
        exit;
    }

    // Rate Limiting Check (Aynı MAC için son 1 dakikada SMS gönderilmiş mi?)
    $stmt = $conn->prepare("SELECT id FROM guest_otp WHERE mac = ? AND created_at > NOW() - INTERVAL 1 MINUTE LIMIT 1");
    $stmt->bind_param("s", $mac);
    $stmt->execute();
    $stmt->store_result();
    if ($stmt->num_rows > 0) {
        echo json_encode(["success" => false, "message" => "Çok sık SMS talebinde bulundunuz. Lütfen 1 dakika bekleyin."]);
        $stmt->close();
        exit;
    }
    $stmt->close();

    // 6 Haneli OTP şifresi üret
    $otpCode = (string)rand(100000, 999000);
    $expiresAt = date('Y-m-d H:i:s', strtotime('+3 minutes'));

    // Veritabanına kaydet
    $stmt = $conn->prepare("INSERT INTO guest_otp (mac, phone, otp_code, expires_at) VALUES (?, ?, ?, ?)");
    $stmt->bind_param("ssss", $mac, $phone, $otpCode, $expiresAt);
    if (!$stmt->execute()) {
        echo json_encode(["success" => false, "message" => "Veritabanı kayıt hatası: " . $stmt->error]);
        $stmt->close();
        exit;
    }
    $stmt->close();

    // SMS Gönderimi
    if (SIMULATION_MODE) {
        // Simülasyon modunda kodu log dosyasına yazıp istemciye döneriz (Bakiye harcamaz)
        $logFile = '/var/log/captiveportal_sms.log';
        $logMsg = date('[Y-m-d H:i:s]') . " MAC: $mac, Phone: $phone, OTP: $otpCode\n";
        @file_put_contents($logFile, $logMsg, FILE_APPEND);

        echo json_encode([
            "success" => true,
            "message" => "SMS başarıyla gönderildi (Simülasyon Aktif).",
            "otpCode" => $otpCode // Simülasyonda kodu istemciye döneriz
        ]);
        exit;
    } else {
        // Gerçek NetGSM API POST isteği (SSL zorunlu ve JSON formatında)
        $url = 'https://api.netgsm.com.tr/sms/send/otp';
        $payload = json_encode([
            "usercode" => NETGSM_USER,
            "password" => NETGSM_PASS,
            "msgheader" => NETGSM_HEADER,
            "msg" => "Restoran misafir internet erisimi icin dogrulama kodunuz: " . $otpCode,
            "no" => $phone,
            "encoding" => "TR"
        ]);

        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type:application/json'));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        
        $response = curl_exec($ch);
        $curl_err = curl_error($ch);
        curl_close($ch);

        if ($curl_err) {
            echo json_encode(["success" => false, "message" => "SMS API bağlantı hatası: " . $curl_err]);
            exit;
        }

        // NetGSM yanıtını logla
        @file_put_contents('/var/log/netgsm_response.log', date('[Y-m-d H:i:s]') . " Response: $response\n", FILE_APPEND);

        echo json_encode([
            "success" => true,
            "message" => "SMS doğrulama kodu cep telefonunuza gönderildi."
        ]);
        exit;
    }
}

else if ($action === 'verify_otp') {
    $input = json_decode(file_get_contents('php://input'), true);
    $mac = isset($input['mac']) ? cleanMac($input['mac']) : '';
    $otp = isset($input['otp']) ? preg_replace('/[^0-9]/', '', $input['otp']) : '';

    if (empty($mac) || empty($otp)) {
        echo json_encode(["success" => false, "message" => "Eksik parametre."]);
        exit;
    }

    // OTP Doğruluğunu Kontrol Et (Aktif ve süresi geçmemiş)
    $stmt = $conn->prepare("SELECT id FROM guest_otp WHERE mac = ? AND otp_code = ? AND verified = 0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1");
    $stmt->bind_param("ss", $mac, $otp);
    $stmt->execute();
    $stmt->store_result();
    
    if ($stmt->num_rows === 0) {
        echo json_encode(["success" => false, "message" => "Hatalı veya süresi dolmuş doğrulama kodu."]);
        $stmt->close();
        exit;
    }
    $stmt->close();

    // OTP'yi kullanıldı (verified = 1) olarak işaretle
    $stmt = $conn->prepare("UPDATE guest_otp SET verified = 1 WHERE mac = ? AND otp_code = ?");
    $stmt->bind_param("ss", $mac, $otp);
    $stmt->execute();
    $stmt->close();

    // RADIUS Check tablosuna kullanıcı ekle / güncelle (Username = MAC, Password = MAC)
    $username = $mac;
    $password = $mac;

    // Önce varsa eski kayıtları temizle
    $stmt = $conn->prepare("DELETE FROM radcheck WHERE username = ?");
    $stmt->bind_param("s", $username);
    $stmt->execute();
    $stmt->close();

    $stmt = $conn->prepare("DELETE FROM radreply WHERE username = ?");
    $stmt->bind_param("s", $username);
    $stmt->execute();
    $stmt->close();

    // radcheck insert (Kimlik doğrulama için)
    $op = ":=";
    $attribute = "Cleartext-Password";
    $stmt = $conn->prepare("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)");
    $stmt->bind_param("ssss", $username, $attribute, $op, $password);
    $stmt->execute();
    $stmt->close();

    // radreply inserts (Bant genişliği limitleri ve oturum süresi için)
    $op_reply = ":=";
    
    // Download Limiti (WISPr)
    $attr_down = "WISPr-Bandwidth-Max-Down";
    $val_down = RATE_LIMIT_DOWN;
    $stmt = $conn->prepare("INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)");
    $stmt->bind_param("ssss", $username, $attr_down, $op_reply, $val_down);
    $stmt->execute();
    $stmt->close();

    // Upload Limiti (WISPr)
    $attr_up = "WISPr-Bandwidth-Max-Up";
    $val_up = RATE_LIMIT_UP;
    $stmt = $conn->prepare("INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)");
    $stmt->bind_param("ssss", $username, $attr_up, $op_reply, $val_up);
    $stmt->execute();
    $stmt->close();

    // Session Timeout (Oturum Süresi)
    $attr_timeout = "Session-Timeout";
    $val_timeout = SESSION_TIMEOUT;
    $stmt = $conn->prepare("INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)");
    $stmt->bind_param("ssss", $username, $attr_timeout, $op_reply, $val_timeout);
    $stmt->execute();
    $stmt->close();

    echo json_encode(["success" => true, "message" => "Doğrulama başarılı. İnternet erişimi tanımlandı."]);
    exit;
}

else {
    echo json_encode(["success" => false, "message" => "Geçersiz istek eylemi."]);
    exit;
}

// MAC adresini temizleme (Küçük harf yapıp tüm noktalama işaretlerini kaldırır)
function cleanMac($mac) {
    return strtolower(preg_replace('/[^a-fA-F0-9]/', '', $mac));
}
?>
