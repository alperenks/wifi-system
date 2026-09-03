# Simülasyon & Öğrenme Rehberi

Bu rehber, sahaya çıkmadan önce sistemin **tamamını tek bir bilgisayarda, hiç donanım olmadan** çalıştırıp müşteriye kanıtlamak ve her katmanı öğrenmek içindir. Üç seviye vardır; en kolayından en gerçekçiye doğru ilerleyin.

---

## Seviye 0 — Saf Yazılım (donanım yok, 5 dakika)

Amaç: müşteriye "çalışıyor" demeden önce **kendi ekranınızda** tüm 5651 akışını görmek.

```bash
cd backend
npm install
node server.js         # 1. terminal — sunucu + RADIUS + Syslog + Cron
```

Yeni bir terminalde:

```bash
cd backend
npm run simulate 6 3   # 6 sanal misafir, her biri 3 tur gezinsin
```

Ardından tarayıcıda **http://localhost:3000/dashboard** açın. Göreceğiniz şey:

- **Aktif Oturumlar**: her sanal misafir için IP / MAC / telefon / harcanan MB.
- **Gerçek Zamanlı 5651 Logu**: her satır `zaman | tip | MAC | iç IP | kaynak port | hedef IP | hedef port | telefon | detay` — yani "hangi telefon, hangi saniyede, nereye bağlandı".
- **Adli Arama**: bir telefon numarası veya MAC girip o kişinin tüm geçmiş bağlantılarını çekin (kolluk kuvveti senaryosu).
- **Bugünün Günlüğünü Mühürle**: `.log.gz` + `.ts` (zaman damgası) üretir.

> Bu seviyede `SIM_MODE=true` olduğu için **gerçek SMS gitmez**; OTP kodu doğrudan arayüzde/konsolda görünür. Sunucu, gerçek bir NAS'ı taklit ederek arka planda **gerçek RADIUS paketleri** gönderir — yani AAA katmanı sahte değildir, protokol seviyesinde çalışır.

### Elle akış (portal deneyimi)
1. **http://localhost:3000/captive** açın.
2. Telefon numarası girin (`5XXXXXXXXX`) → "Doğrulama Kodu Gönder".
3. Kod ekranda görünür (simülasyon) → girin → "Bağlantı Açık" ekranı gelir.
4. Dashboard'da o oturumun aktifleştiğini görün; "Gezin" ile trafik üretin.

---

## Seviye 1 — ESP32 Access Point + PC (gerçek Wi-Fi, sanal ağ geçidi)

Amaç: gerçek bir telefonun gerçek Wi-Fi ile portala düşmesini görmek.

- `esp32-ap/esp32-ap.ino` kodunu ESP32'ye yükleyin. ESP32 `Restoran_Misafir_Wifi` yayınlar (192.168.4.1), DNS'i PC'ye yönlendirir ve yetkisiz HTTP'yi PC'deki portala 302 ile atar.
- PC'yi bu ağa bağlayın, `node server.js` çalıştırın. `esp32-ap.ino` içindeki `portalServerIP`'yi PC'nin ESP32 ağındaki IP'siyle güncelleyin.
- `.env` içinde `ESP32_AP_URL=http://192.168.4.1` yapın. Böylece OTP doğrulanınca Node, ESP32'ye `/authorize?mac=...` gönderip cihazın geçişini açar.
- Telefonu ağa bağlayın → "Ağa Katıl" ekranı → SMS akışı → erişim.

---

## Seviye 2 — pfSense Sanal Makine (saha mimarisinin birebir kopyası)

Amaç: sahada kuracağınız pfSense mimarisini VirtualBox'ta prova etmek.

> **Önemli mimari karar:** pfSense'e MySQL veya FreeRADIUS paketi **KURMAYIN**.
> pfSense'in Captive Portal'ı doğrudan bilgisayarınızdaki Node RADIUS sunucusuna
> (UDP 1812/1813) sorar. Böylece portal, SMS, dashboard, 5651 logu ve mühürleme —
> yani inşa ettiğiniz sistemin tamamı — gerçekten test edilir. README'deki
> MySQL/FreeRADIUS kurulumu Node'suz çalışan alternatif (eski) yoldur.

Test iki aşamada yapılır: önce **Aşama A** (sanal istemci — %100 güvenilir),
sonra **Aşama B** (ESP32 + gerçek telefon — Wi-Fi köprü riskli, fallback'li).

### Aşama A — pfSense + Sanal İstemci (kablosuz yok, deterministik)

**1. VirtualBox ağını hazırlayın**

- File > Tools > **Network Manager** → Host-Only ağını seçin (örn. `192.168.56.0/24`).
- **DHCP Server sekmesinde VirtualBox DHCP'sini KAPATIN** (pfSense dağıtacak).
- Host PC bu ağda otomatik olarak `192.168.56.1` olur — Node sunucusu burada koşacak.

**2. pfSense VM adaptörleri**

| Adaptör | Mod | Görev |
|---|---|---|
| Adapter 1 | NAT | WAN — internete çıkış |
| Adapter 2 | Host-Only | LAN — misafir ağı |

pfSense konsolunda LAN'a statik `192.168.56.2/24` verin, DHCP aralığı `192.168.56.100–200`.

**3. Windows güvenlik duvarı (host'ta, yönetici PowerShell)**

```powershell
New-NetFirewallRule -DisplayName "WifiSys Portal 3000"  -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
New-NetFirewallRule -DisplayName "WifiSys RADIUS"       -Direction Inbound -Protocol UDP -LocalPort 1812,1813 -Action Allow
New-NetFirewallRule -DisplayName "WifiSys Syslog 514"   -Direction Inbound -Protocol UDP -LocalPort 514 -Action Allow
```

**4. pfSense Web UI ayarları** (`http://192.168.56.2` — paket kurulumu YOK)

1. **System > User Manager > Authentication Servers** → Add:
   Type `RADIUS`, IP `192.168.56.1`, Shared Secret `<RADIUS_SECRET_DEGERINIZ>`
   (`backend/.env` içindeki `RADIUS_SECRET` ile **birebir aynı** olmalı; belgede
   gerçek bir sır yazmıyoruz), Services `Authentication and Accounting`,
   Auth port `1812`, Acct port `1813`.
2. **Services > Captive Portal** → Add Zone (örn. `misafir`, LAN interface) → Enable.
   - **Authentication Method**: "Use an Authentication backend" → yukarıdaki RADIUS sunucusu.
   - **RADIUS options**: "Send RADIUS accounting" işaretli.
   - **Allowed IP Addresses** sekmesi: `192.168.56.1` ekleyin (yetkisiz istemcinin
     Node portalına ve `/api/*` uçlarına erişebilmesi için — walled garden).
   - **File Manager** sekmesi: `pfsense-files/captiveportal-redirect.php` yükleyin.
     Yüklemeden önce dosyadaki `NODE_PORTAL` IP'sinin `192.168.56.1` olduğundan emin olun.
   - **Portal page contents**: `pfsense-files/portal-page.html` yükleyin.
3. **Firewall > Rules > LAN** → varsayılan "Default allow LAN to any" kuralını
   düzenleyin → **Log packets that are handled by this rule** işaretleyin
   (filterlog satırları — yani 5651 NAT logları — ancak böyle üretilir!).
4. **Status > System Logs > Settings** → Remote Logging:
   Remote log server `192.168.56.1:514`, içerik olarak "Everything"
   (veya en az Firewall Events + DNS).
5. **Services > DNS Resolver > Custom options**:
   ```
   server:
   log-queries: yes
   ```
   (unbound DNS sorgu logları — "hangi siteye girdi" verisi buradan gelir).

**5. Node tarafı (host PC)**

```bash
cd backend
# .env içinde: SIM_MODE=false   <- gateway modu: sahte oturum açılmaz,
#                                  gerçek oturumları pfSense Accounting ile açar.
# NetGSM alanları boşsa SMS yine simüle edilir ve OTP ekranda görünür (kontör gitmez).
node server.js
```

**6. İstemci VM**

Aynı Host-Only ağa bağlı, tarayıcısı olan herhangi bir hafif VM (Lubuntu live ISO yeterli).

**Aşama A doğrulama zinciri:**

1. İstemci VM açılır → pfSense'ten IP alır (`Status > DHCP Leases`'ta görünür).
2. Tarayıcıda herhangi bir HTTP site (örn. `http://neverssl.com`) → pfSense yakalar →
   `portal-page.html` → `captiveportal-redirect.php` (MAC'i ARP'tan bulur) →
   Node portalı açılır, MAC/IP dolu.
3. Telefon + OTP girilir → gizli form pfSense'e POST edilir → pfSense, Node'a
   **Access-Request** atar (host konsolunda `[RADIUS-AUTH] Access-Accept` görünür) →
   istemcinin **gerçek interneti açılır**.
4. pfSense **Accounting-Start** gönderir → `http://localhost:3000/dashboard` →
   oturum gerçek DHCP IP'siyle listede.
5. İstemcide birkaç site gezin → filterlog + unbound satırları UDP 514'ten akar →
   5651 log satırlarında **telefon numarası çözülmüş** olarak görünür.
6. Wireshark (host, Host-Only adaptörü): `radius` ve `udp.port==514` filtreleri.
7. Dashboard'dan "Mühürle" → `.log.gz` + `.ts` üretilir.

> Not: Portal sayfası ilk açılışta Google Fonts yükleyemez (istemci henüz internete
> çıkamıyor) — yazı tipi sistem fontuna düşer, akış etkilenmez.

### Aşama B — ESP32 + Gerçek Telefon (fiziksel Wi-Fi)

```
Telefon ─Wi-Fi─> ESP32 AP (köprü, DHCP KAPALI) <─Wi-Fi─ PC kartı <─VBox Bridged─ pfSense LAN
```

1. `esp32-bridge/esp32-bridge.ino` dosyasını ESP32'ye yükleyin — bu sürümde ESP32'nin
   kendi DHCP'si kapatıldı; IP dağıtımını pfSense yapar (aksi halde iki DHCP yarışır
   ve portal hiç tetiklenmez).
2. PC'nin Wi-Fi kartını `Restoran_Misafir_Wifi` ağına bağlayın.
3. pfSense VM'de **Adapter 2'yi Host-Only yerine Bridged → PC'nin Wi-Fi kartı** yapın.
4. Artık Node'un LAN IP'si değişir: `ipconfig` ile PC'nin bu ağdaki IP'sini bulun;
   `captiveportal-redirect.php` içindeki `NODE_PORTAL` ve pfSense **Allowed IP**
   listesini bu IP ile güncelleyin.
5. Telefonu `Restoran_Misafir_Wifi` ağına bağlayın → "Ağa Katıl" (CNA) ekranı →
   Aşama A'daki doğrulama zincirinin aynısı.

**⚠ Bilinen risk:** VirtualBox, Wi-Fi kartı üzerinden köprülerken MAC-NAT kullanır;
pfSense'in telefonlara DHCP dağıtması bazı kartlarda/sürücülerde çalışmaz.
**Kontrol noktası:** telefon bağlandıktan sonra pfSense `Status > DHCP Leases`'ta
görünüyor mu? Görünmüyorsa köprü çalışmıyordur. Bu durumda:

- **Fallback 1 (önerilen):** Telefon deneyimini **Seviye 1** ile test edin
  (`esp32-ap.ino` + Node, pfSense'siz) — gerçek CNA ekranı ve SMS akışı kanıtlanır.
  pfSense entegrasyonu zaten Aşama A'da kanıtlanmıştır; iki test birlikte tam
  kapsama sağlar.
- **Fallback 2:** USB-Ethernet adaptör + AP modunda eski bir router: pfSense LAN'ı
  Ethernet'e köprüleyin (Ethernet köprüleme VirtualBox'ta sorunsuzdur) — bu, sahadaki
  gerçek mimariyle birebir aynıdır.

---

## Hangi dosya ne iş yapıyor?

| Katman | Dosya | Görev |
|---|---|---|
| Yapılandırma | `backend/config.js` + `.env` | Tüm ayarlar tek yerde (SIM_MODE, NetGSM, RADIUS, ağ profili) |
| Portal + API | `backend/server.js` | Captive portal, OTP, `/api/sim/*`, dashboard API'leri |
| SMS | `backend/netgsm.js` | Gerçek NetGSM OTP POST'u; SIM_MODE'da otomatik simüle |
| Kimlik (AAA) | `backend/radius-server.js` | UDP 1812/1813 FreeRADIUS taklidi (Access/Accounting) |
| NAS taklidi | `backend/radius-client.js` | Gerçek NAS gibi RADIUS paketi üretir (yazılım demo için) |
| Log toplama | `backend/syslog-server.js` | UDP 514, pfSense/MikroTik loglarını 5651 formatına çevirir |
| Mühürleme | `backend/kamusm-signer.js` | Günlük `.gz` + SHA-256 + RFC 3161 zaman damgası (mock) |
| Veri | `backend/db.js` | guestFlows, radcheck/reply/acct, DHCP kira (MAC↔IP) |
| Demo sürücüsü | `backend/simulate.js` | `npm run simulate` — kalabalık misafir senaryosu |

---

## Sık karşılaşılan sorunlar

- **Port 514/1812/1813 açılmıyor**: Başka bir Syslog/RADIUS servisi çalışıyor olabilir. Windows'ta `Get-NetTCPConnection -LocalPort 1812` ile kontrol edin. Portları `.env` üzerinden değiştirebilirsiniz.
- **`npm run simulate` "Sunucuya ulaşılamadı" diyor**: Önce ayrı terminalde `node server.js` çalıştırın.
- **`simulate` "SIM_MODE=false" uyarısı**: `.env` içinde `SIM_MODE=true` yapın (yalnızca yazılım demosu için).
- **Loglarda `BILINMEYEN_TEL`**: O IP için aktif oturum/DHCP kirası yok. Önce misafiri bağlayın (portal veya `full-guest`).
