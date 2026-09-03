/*
  =============================================================================
  5651 Sayılı Kanun Uyumlu Captive Portal Simülatörü - ESP32 Access Point Yazılımı
  =============================================================================
  Bu yazılım, ESP32'yi fiziksel bir Captive Portal Access Point haline getirir.
  
  Çalışma Akışı:
  1. ESP32 "Restoran_Misafir_Wifi" adında şifresiz bir ağ yayınlar (IP: 192.168.4.1).
  2. Test bilgisayarınız bu ağa bağlanır ve ESP32'den IP alır (örn: 192.168.4.2). 
     Bilgisayarınızda Node.js Portal sunucusu çalışmaktadır.
  3. Müşterinin telefonu da bu Wi-Fi ağına bağlanır (örn: 192.168.4.3).
  4. Telefondan herhangi bir siteye (örn: apple.com, google.com) gidilmek istendiğinde,
     ESP32 DNS sunucusu tüm sorguları bilgisayarınızın IP'sine (192.168.4.2) yönlendirir (DNS Spoofing).
  5. Cihazın işletim sistemi (iOS/Android) "Ağa Katıl" (CNA) ekranını tetikler. ESP32, gelen HTTP isteklerini
     bilgisayarınızdaki Node.js portalına yönlendirir: http://192.168.4.2:3000/captive
  6. Kullanıcı portalda SMS doğrulamasını yapıp şifreyi girdiğinde, Node.js sunucumuz 
     ESP32 üzerindeki "/authorize" API ucuna istek atarak bu MAC adresini doğrular.
  7. ESP32 artık bu MAC adresine yönlendirme yapmaz (Simüle internet erişimi verir).
*/

#include <WiFi.h>
#include <DNSServer.h>
#include <WebServer.h>

// Wi-Fi Konfigürasyonu
const char* ssid = "Restoran_Misafir_Wifi";
const byte DNS_PORT = 53;

// IP Adresleri
IPAddress apIP(192.168.4.1);
IPAddress netMsk(255, 255, 255, 0);

// Node.js Portal Sunucusu Bilgileri (Bilgisayarınızın ESP32 ağındaki IP'si)
// Bilgisayarınız ESP32'ye bağlandığında genellikle 192.168.4.2 alır.
const char* portalServerIP = "192.168.4.2"; 
const char* portalPort = "3000";

DNSServer dnsServer;
WebServer server(80);

// Yetkilendirilmiş MAC adreslerini tutan liste (Simülasyon için)
#define MAX_AUTHORIZED_DEVICES 20
String authorizedMacs[MAX_AUTHORIZED_DEVICES];
int authDeviceCount = 0;

// Yardımcı Fonksiyon: MAC adresi listede var mı?
bool isMacAuthorized(String mac) {
  mac.toLowerCase();
  for (int i = 0; i < authDeviceCount; i++) {
    if (authorizedMacs[i] == mac) return true;
  }
  return false;
}

// Yardımcı Fonksiyon: MAC adresini yetkilendir
void authorizeMac(String mac) {
  mac.toLowerCase();
  if (isMacAuthorized(mac)) return;
  
  if (authDeviceCount < MAX_AUTHORIZED_DEVICES) {
    authorizedMacs[authDeviceCount++] = mac;
    Serial.println("YENI CIHAZ YETKILENDIRILDI: " + mac);
  } else {
    // Liste doluysa en eskiyi silip yeniyi ekle (FIFO)
    for (int i = 1; i < MAX_AUTHORIZED_DEVICES; i++) {
      authorizedMacs[i-1] = authorizedMacs[i];
    }
    authorizedMacs[MAX_AUTHORIZED_DEVICES - 1] = mac;
    Serial.println("Yetkilendirme listesi doldu, FIFO uygulandi. Yeni MAC: " + mac);
  }
}

// İstemcinin MAC adresini IP adresinden tespit etme (ARP tablosundan ESP32 SDK'sı alır)
String getClientMac() {
  // ESP32 WebServer kütüphanesinde istemci IP'si alınabilir
  IPAddress clientIP = server.client().remoteIP();
  
  // WiFi kütüphanesini kullanarak bağlı istasyon listesinden MAC bulma
  wifi_sta_list_t wifi_sta_list;
  tcpip_adapter_sta_list_t adapter_sta_list;
  
  memset(&wifi_sta_list, 0, sizeof(wifi_sta_list));
  memset(&adapter_sta_list, 0, sizeof(adapter_sta_list));
  
  esp_wifi_ap_get_sta_list(&wifi_sta_list);
  tcpip_adapter_get_sta_list(&wifi_sta_list, &adapter_sta_list);
  
  for (int i = 0; i < adapter_sta_list.num; i++) {
    tcpip_adapter_sta_info_t station = adapter_sta_list.sta[i];
    IPAddress staIP(station.ip.addr);
    if (staIP == clientIP) {
      char macStr[18];
      snprintf(macStr, sizeof(macStr), "%02x:%02x:%02x:%02x:%02x:%02x", 
               station.mac[0], station.mac[1], station.mac[2], 
               station.mac[3], station.mac[4], station.mac[5]);
      return String(macStr);
    }
  }
  return "00:00:00:00:00:00";
}

// Captive Portal Yönlendirme Mantığı
void handleCaptivePortal() {
  String clientMac = getClientMac();
  IPAddress clientIP = server.client().remoteIP();
  String hostHeader = server.hostHeader();

  Serial.println("[INTERCEPT] İstek: " + hostHeader + " -> İstemci: " + clientIP.toString() + " (" + clientMac + ")");

  // Eğer cihaz daha önce portalda doğrulanmışsa, internete erişimine (simüle) izin ver
  if (isMacAuthorized(clientMac)) {
    server.send(200, "text/html", "<html><head><meta charset='UTF-8'></head><body><h1>Simüle İnternet Erişimi Aktif</h1><p>Cihazınız başarıyla doğrulanmıştır ve sistem internet trafiğinizi 5651 kapsamında loglamaktadır.</p></body></html>");
    return;
  }

  // Yetkisiz cihazları Node.js Portal Sunucusuna 302 Redirect ile yönlendir
  String redirectUrl = "http://" + String(portalServerIP) + ":" + String(portalPort) + "/captive";
  redirectUrl += "?mac=" + clientMac;
  redirectUrl += "&ip=" + clientIP.toString();
  redirectUrl += "&redirurl=http://" + hostHeader + server.uri();

  Serial.println("[REDIRECT] -> " + redirectUrl);
  
  server.sendHeader("Location", redirectUrl, true);
  server.send(302, "text/plain", ""); // Empty body for redirect
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- ESP32 Captive Portal Simülatörü Başlatılıyor ---");

  // Wi-Fi Access Point Ayarları
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, netMsk);
  WiFi.softAP(ssid);

  Serial.print("Access Point SSID: ");
  Serial.println(ssid);
  Serial.print("ESP32 AP IP Adresi: ");
  Serial.println(WiFi.softAPIP());

  // DNS Sunucusunu Başlat (Tüm sorguları ESP32 AP IP'sine veya Node.js IP'sine yönlendir)
  // pfSense ve ağ geçidi davranışını simüle etmek için tüm sorguları portal bilgisayarına yönlendiriyoruz
  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServer.start(DNS_PORT, "*", apIP);
  Serial.println("DNS Spoofing sunucusu başlatıldı.");

  // --- API Uç Noktaları ---

  // Node.js portalının doğrulama sonrası ESP32'ye "bu MAC onaylandı" demesi için endpoint
  // GET http://192.168.4.1/authorize?mac=00:aa:bb:cc:dd:ee
  server.on("/authorize", HTTP_GET, []() {
    if (server.hasArg("mac")) {
      String mac = server.arg("mac");
      authorizeMac(mac);
      server.send(200, "application/json", "{\"success\":true,\"message\":\"MAC authorized.\"}");
    } else {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing mac parameter.\"}");
    }
  });

  // Yetkilendirilmiş cihazların listesi
  server.on("/list", HTTP_GET, []() {
    String json = "{\"authorized_devices\":[";
    for(int i=0; i<authDeviceCount; i++) {
      json += "\"" + authorizedMacs[i] + "\"";
      if(i < authDeviceCount - 1) json += ",";
    }
    json += "]}";
    server.send(200, "application/json", json);
  });

  // Herhangi bir yönlendirilmemiş istek gelirse Captive Portal yönlendirmesini çalıştır
  server.onNotFound(handleCaptivePortal);

  server.begin();
  Serial.println("Web Sunucu port 80 üzerinde başlatıldı.");
}

void loop() {
  dnsServer.processNextRequest();
  server.handleClient();
}
