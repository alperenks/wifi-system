<?php
// ====================================================================
// pfSense -> Node Portal Yönlendirici (captiveportal-redirect.php)
// ====================================================================
// ÖNERİLEN ENTEGRASYON YOLU (MySQL/FreeRADIUS GEREKMEZ):
//   pfSense Captive Portal --RADIUS--> Node radius-server.js (host PC)
//   Portal sayfası + SMS + 5651 log + mühürleme = Node backend
//
// Bu dosya pfSense Captive Portal "File Manager" ile yüklenir
// (captiveportal- öneki zorunludur; yüklenen .php dosyaları portal web
// sunucusu tarafından çalıştırılır). Portal sayfası (portal-page.html)
// istemciyi buraya gönderir; biz de MAC/IP'yi tespit edip Node'daki
// gerçek portala 302 ile yönlendiririz.
//
// KURULUMDA DEĞİŞTİRİN: NODE_PORTAL adresini, Node sunucusunun pfSense
// LAN tarafından erişilen IP'siyle güncelleyin (Aşama A: 192.168.56.1).
// Bu IP'yi Captive Portal "Allowed IP Addresses" listesine de ekleyin!

define("NODE_PORTAL", "http://192.168.56.1:3000/captive");

$clientIp = $_SERVER['REMOTE_ADDR'];
$zone     = isset($_GET['zone']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['zone']) : '';
$redirurl = isset($_GET['redirurl']) ? $_GET['redirurl'] : 'http://www.google.com';

// İstemcinin MAC adresini FreeBSD ARP tablosundan bul
// Örnek satır: ? (192.168.56.100) at 08:00:27:aa:bb:cc on em1 expires ...
$mac = '';
$out = array();
exec("/usr/sbin/arp -n " . escapeshellarg($clientIp), $out);
foreach ($out as $line) {
    if (preg_match('/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i', $line, $m)) {
        $mac = strtolower($m[1]);
        break;
    }
}

// Gizli login formunun geri POST edeceği pfSense portal ucu
// (varsayilan ilk zone portu 8002'dir; SERVER_ADDR/PORT bunu otomatik verir)
$gatewayUrl = 'http://' . $_SERVER['SERVER_ADDR'] . ':' . $_SERVER['SERVER_PORT']
            . '/index.php?zone=' . $zone;

$target = NODE_PORTAL
        . '?mac='        . urlencode($mac)
        . '&ip='         . urlencode($clientIp)
        . '&gatewayurl=' . urlencode($gatewayUrl)
        . '&redirurl='   . urlencode($redirurl);

header("Location: " . $target, true, 302);
exit;
?>
