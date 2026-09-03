/*
  =============================================================================
  5651 Uyumlu Hotspot - ESP32 Kablosuz Köprü (Bridge AP) + İmzalı Yetkilendirme
  =============================================================================
  Bu yazılım iki iş yapar:
   1) ESP32'yi şeffaf bir kablosuz erişim noktasına (SoftAP köprü) çevirir.
   2) Backend'den gelen HMAC İMZALI yetkilendirme isteklerini doğrular (F-03).

  GÜVENLİK (F-03):
  Backend, OTP doğrulanınca buraya şu isteği gönderir:
      POST /authorize
      Gövde:  {"mac":"aabbcc...","ts":<unix_sn>,"nonce":"<rastgele>"}
      Başlık: X-Signature: HMAC-SHA256(gövdenin birebir metni, SHARED_SECRET) [hex]
  ESP32:
    - İmzayı yeniden hesaplar ve SABİT ZAMANLI karşılaştırır (imzasız/yanlış istek reddedilir),
    - nonce'u son 16 nonce'luk halka tamponunda arar (REPLAY reddedilir),
    - ts'in monoton ilerlediğini kontrol eder (eski isteğin tekrarını reddeder).
  Doğrulanan MAC yerel izin listesine eklenir ve seri porta yazılır.

  DÜRÜST SINIR: ESP32 SoftAP köprü modunda L2 trafiğini donanımda geçirir; bu izin
  listesi FİİLİ trafik engellemesi yapmaz — asıl uygulama ağ geçidinin (pfSense) işidir.
  Burada amaç, "yetkilendirme kanalının" kimlik doğrulamalı ve replay'e kapalı olmasıdır.

  Paylaşılan sır: secrets.h içindeki SHARED_SECRET, backend .env'deki
  ESP32_SHARED_SECRET ile AYNI olmalıdır. secrets.h git'e girmez (bkz. .gitignore);
  secrets.example.h dosyasını kopyalayıp doldurun.
*/

#include <WiFi.h>
#include <WebServer.h>
#include "mbedtls/md.h"
#include "secrets.h"   // #define SHARED_SECRET "..."
#include "esp_wifi.h"
#include "esp_idf_version.h"
// DHCP durdurma API'si core sürümüne göre değişti (2.x: tcpip_adapter, 3.x: esp_netif).
// Her iki durumda da derlensin diye doğru başlığı sürüme göre dahil ediyoruz.
#if ESP_IDF_VERSION_MAJOR >= 5
  #include "esp_netif.h"
#else
  #include "tcpip_adapter.h"
#endif

// SoftAP'nin kendi DHCP'sini kapatır (SAHA modu). Core sürümünden bağımsız çalışır.
static void stopSoftApDhcp() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_netif_t* ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (ap) esp_netif_dhcps_stop(ap);
#else
  tcpip_adapter_dhcps_stop(TCPIP_ADAPTER_IF_AP);
#endif
}

const char* ssid = "Restoran_Misafir_Wifi";
const int   CLOCK_TOLERANCE_SEC = 30;   // backend ESP32_CLOCK_TOLERANCE_SEC ile uyumlu

// ---------------------------------------------------------------------------
// TEZGAH TESTI MODU
// 1 = ESP32 kendi DHCP'sini AÇIK tutar; laptop bağlanınca 192.168.4.x IP alır ve
//     http://192.168.4.1/authorize endpoint'ini tek cihazla (ağ geçidi olmadan)
//     test edebilirsin. Sadece donanım bring-up / imza testi için.
// 0 = SAHA modu: DHCP KAPALI, IP dağıtımı pfSense/MikroTik'e bırakılır (gerçek dağıtım).
// ---------------------------------------------------------------------------
#define BENCH_TEST 1

WebServer server(80);

// --- Replay koruması: son 16 nonce'un halka tamponu + monoton ts ---
#define NONCE_RING 16
String seenNonces[NONCE_RING];
int    nonceIdx = 0;
long   lastAcceptedTs = 0;

// --- Yerel izin listesi (doğrulanan MAC'ler) ---
#define ALLOW_MAX 32
String allowedMacs[ALLOW_MAX];
int    allowedCount = 0;

// Basit JSON alan çıkarıcı: "key":"value"  veya  "key":number
String jsonStr(const String& body, const String& key) {
  int k = body.indexOf("\"" + key + "\"");
  if (k < 0) return "";
  int c = body.indexOf(':', k);
  if (c < 0) return "";
  int i = c + 1;
  while (i < (int)body.length() && (body[i] == ' ' || body[i] == '\t')) i++;
  if (i < (int)body.length() && body[i] == '"') {           // string değer
    int end = body.indexOf('"', i + 1);
    if (end < 0) return "";
    return body.substring(i + 1, end);
  }
  int end = i;                                              // sayısal değer
  while (end < (int)body.length() && body[end] != ',' && body[end] != '}' && body[end] != ' ') end++;
  return body.substring(i, end);
}

// HMAC-SHA256(body, SHARED_SECRET) -> küçük harf hex
String hmacHex(const String& body) {
  byte hmac[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)SHARED_SECRET, strlen(SHARED_SECRET));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)body.c_str(), body.length());
  mbedtls_md_hmac_finish(&ctx, hmac);
  mbedtls_md_free(&ctx);

  String out;
  const char* hexd = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out += hexd[hmac[i] >> 4]; out += hexd[hmac[i] & 0x0F]; }
  return out;
}

// Sabit zamanlı string karşılaştırma (uzunluk sızıntısına dikkat: eşit uzunlukta değilse reddet)
bool constEq(const String& a, const String& b) {
  if (a.length() != b.length()) return false;
  byte diff = 0;
  for (int i = 0; i < (int)a.length(); i++) diff |= (a[i] ^ b[i]);
  return diff == 0;
}

bool nonceSeen(const String& nonce) {
  for (int i = 0; i < NONCE_RING; i++) if (seenNonces[i] == nonce) return true;
  return false;
}
void rememberNonce(const String& nonce) {
  seenNonces[nonceIdx] = nonce;
  nonceIdx = (nonceIdx + 1) % NONCE_RING;
}

void authorizeMac(const String& mac) {
  for (int i = 0; i < allowedCount; i++) if (allowedMacs[i] == mac) return;
  if (allowedCount < ALLOW_MAX) allowedMacs[allowedCount++] = mac;
  else { for (int i = 1; i < ALLOW_MAX; i++) allowedMacs[i-1] = allowedMacs[i]; allowedMacs[ALLOW_MAX-1] = mac; }
}

void handleAuthorize() {
  if (server.method() != HTTP_POST) { server.send(405, "application/json", "{\"error\":\"method\"}"); return; }

  String body = server.hasArg("plain") ? server.arg("plain") : "";
  String sig  = server.hasHeader("X-Signature") ? server.header("X-Signature") : "";

  // 1) İmza doğrulama (imzasız/yanlış istek burada durur)
  if (sig.length() == 0 || !constEq(sig, hmacHex(body))) {
    Serial.println("[AUTH] REDDEDILDI: imza gecersiz/eksik");
    server.send(401, "application/json", "{\"error\":\"bad_signature\"}");
    return;
  }

  String mac   = jsonStr(body, "mac");
  String nonce = jsonStr(body, "nonce");
  long   ts    = jsonStr(body, "ts").toInt();
  if (mac.length() == 0 || nonce.length() == 0 || ts == 0) {
    server.send(400, "application/json", "{\"error\":\"bad_body\"}");
    return;
  }

  // 2) Replay: aynı nonce tekrar gelemez
  if (nonceSeen(nonce)) {
    Serial.println("[AUTH] REDDEDILDI: nonce tekrari (replay)");
    server.send(401, "application/json", "{\"error\":\"replay\"}");
    return;
  }

  // 3) Monoton ts: kabul edilen en son ts'ten belirgin biçimde eski istek reddedilir.
  //    (NTP/RTC olmadan mutlak saat bilinmez; monoton kontrol + nonce replay'i kapatır.)
  if (lastAcceptedTs > 0 && ts < lastAcceptedTs - CLOCK_TOLERANCE_SEC) {
    Serial.println("[AUTH] REDDEDILDI: eski zaman damgasi (stale)");
    server.send(401, "application/json", "{\"error\":\"stale\"}");
    return;
  }

  // Geçerli — kaydet ve yetkilendir
  rememberNonce(nonce);
  if (ts > lastAcceptedTs) lastAcceptedTs = ts;
  authorizeMac(mac);
  Serial.print("[AUTH] ONAYLANDI mac="); Serial.println(mac);
  server.send(200, "application/json", "{\"status\":\"authorized\"}");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- ESP32 Kablosuz Kopru (AP) + Imzali Yetkilendirme Baslatiliyor ---");

  WiFi.mode(WIFI_AP);
  IPAddress apIP(192, 168, 4, 1);
  IPAddress netMsk(255, 255, 255, 0);
  WiFi.softAPConfig(apIP, apIP, netMsk);

  if (WiFi.softAP(ssid, NULL, 1, 0, 10)) {
#if BENCH_TEST
    // TEZGAH: DHCP açık kalır — laptop 192.168.4.x IP alır, endpoint'i test edebilirsin.
    Serial.println("==========================================");
    Serial.print("Kablosuz Ag Aktif: "); Serial.println(ssid);
    Serial.print("ESP32 IP Adresi  : "); Serial.println(WiFi.softAPIP());
    Serial.println("MOD: TEZGAH TESTI — DHCP ACIK (laptop IP alir).");
    Serial.println("Test           : POST http://192.168.4.1/authorize (HMAC imzali)");
    Serial.println("==========================================");
#else
    // SAHA: ESP32 kendi DHCP'sini kapatır; IP dağıtımını pfSense/MikroTik yapar.
    stopSoftApDhcp();
    Serial.println("==========================================");
    Serial.print("Kablosuz Ag Aktif: "); Serial.println(ssid);
    Serial.print("ESP32 IP Adresi  : "); Serial.println(WiFi.softAPIP());
    Serial.println("MOD: SAHA — DHCP KAPALI, IP dagitimi ag gecidine birakildi.");
    Serial.println("Yetkilendirme  : POST http://192.168.4.1/authorize (HMAC imzali)");
    Serial.println("==========================================");
#endif
  } else {
    Serial.println("SoftAP baslatilamadi!");
  }

  // X-Signature başlığını okuyabilmek için topla
  const char* headerKeys[] = { "X-Signature" };
  server.collectHeaders(headerKeys, 1);
  server.on("/authorize", handleAuthorize);
  server.onNotFound([]() { server.send(404, "application/json", "{\"error\":\"not_found\"}"); });
  server.begin();
  Serial.println("[HTTP] Yetkilendirme sunucusu :80 dinliyor.");
}

void loop() {
  server.handleClient();

  static int lastClientCount = 0;
  int currentClientCount = WiFi.softAPgetStationNum();
  if (currentClientCount != lastClientCount) {
    Serial.print("[WIFI-AP] Bagli istemci sayisi degisti: ");
    Serial.println(currentClientCount);
    lastClientCount = currentClientCount;
  }
}
