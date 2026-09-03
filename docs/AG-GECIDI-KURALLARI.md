# AĞ GEÇİDİ KURAL SETİ — Misafir Wi-Fi (pfSense / MikroTik)

> **Bu belge neden var?** Backend "kimlik doğrularım ve loglarım" der; misafiri
> **sınırlayan** katman ağ geçididir. İçerik filtreleme, iç ağ izolasyonu ve DNS
> zorlaması captive portal yazılımının değil, pfSense/MikroTik'in işidir.
> `docs/GUVENLIK-DEGERLENDIRMESI.md` §1'de eksik olarak işaretlenen kural seti budur.
>
> **Hedef:** Bir ağ yöneticisi bu belgeyi yukarıdan aşağı uygulayarak sahayı
> kurabilsin. Komutlar RouterOS 7 ve pfSense 2.7 içindir; **önce test cihazında**
> deneyin, sonra sahaya alın.

---

## 0. Ağ planı (tüm belge bu adreslemeye göre yazıldı)

| Ağ | Aralık | Ne var? |
|---|---|---|
| **İÇ AĞ (LAN)** | `192.168.10.0/24` | Kasa/POS, NAS, kameralar, personel bilgisayarları |
| **MİSAFİR (VLAN 20)** | `192.168.20.0/24` | Yalnızca misafir telefonları/laptopları |
| Misafir DHCP havuzu | `192.168.20.100 – 192.168.20.200` | `backend/.env` → `LAN_PREFIX`, `LEASE_START`, `LEASE_END` ile **aynı** olmalı |
| Ağ geçidi (misafir tarafı) | `192.168.20.1` | pfSense/MikroTik |
| **Portal + RADIUS + syslog sunucusu** | `192.168.10.5` | Node backend'in koştuğu mini PC |

Portal sunucusunun dinlediği portlar (`backend/.env` ile eşleşmeli):

| Port | Protokol | Yön | İş |
|---|---|---|---|
| 3000 | TCP (saha: HTTPS) | misafir → sunucu | Captive portal sayfası, OTP |
| 1812 | UDP | ağ geçidi → sunucu | RADIUS kimlik doğrulama |
| 1813 | UDP | ağ geçidi → sunucu | RADIUS accounting (5651 oturum delili) |
| 514 | UDP | ağ geçidi → sunucu | Syslog (DNS + NAT kayıtları) |
| 3799 | UDP | **sunucu → ağ geçidi** | RFC 5176 CoA/Disconnect (veri kotası, F-10) |

> ⚠️ 3799 ters yöndedir: kotayı aşan misafiri düşürmek için RADIUS sunucusu
> ağ geçidine paket gönderir. Ağ geçidi bu portu **dinlemeli**, güvenlik duvarı
> yalnızca `192.168.10.5`'ten gelen paketi kabul etmelidir.

---

## 1. Altın kurallar (sıralama önemlidir)

Güvenlik duvarı kuralları **yukarıdan aşağı** işletilir; ilk eşleşen kazanır.
Misafir arayüzünde sıra şu olmalı:

1. **İZİN** — DHCP (UDP 67/68) → ağ geçidi
2. **İZİN** — DNS (UDP/TCP 53) → **yalnızca ağ geçidi**
3. **İZİN** — Portal sunucusu (`192.168.10.5:3000`) → doğrulama öncesi erişilebilsin
4. **RED** — Misafir → **iç ağ** (`192.168.10.0/24` ve diğer RFC1918) ← *en kritik kural*
5. **RED** — Misafir → ağ geçidinin yönetim portları (22/80/443/8291)
6. **RED** — Riskli portlar (SMB, NetBIOS, RDP, Telnet, SMTP, DoT)
7. **İZİN** — Kalan her şey → internet (yalnızca doğrulanmış oturumlar için)

3. kural olmadan misafir portalı açamaz; 4. kural olmadan misafir kasanın
POS cihazına erişebilir. İkisi de sahada tek başına yeterli değildir — **hepsi** gerekir.

---

## 2. pfSense adım adım

### 2.1 Arayüz ve VLAN

1. **Interfaces → Assignments → VLANs → Add**
   Parent: LAN kartı, VLAN Tag `20`, Description `MISAFIR`.
2. **Interfaces → Assignments** → yeni VLAN'ı `OPT1` olarak ekleyin.
3. **Interfaces → OPT1**: Enable, Description `MISAFIR`,
   IPv4 Static `192.168.20.1/24`, IPv6 **None** (IPv6 açık kalırsa kurallar atlanabilir).

### 2.2 DHCP

**Services → DHCP Server → MISAFIR**
- Enable, Range `192.168.20.100` – `192.168.20.200`
- DNS servers: **yalnızca** `192.168.20.1`
- Gateway: `192.168.20.1`, Lease time: `7200` (portal `SESSION_TIMEOUT` ile aynı)

### 2.3 Alias'lar (kuralları okunur tutar)

**Firewall → Aliases → IP**
- `IC_AGLAR` → `192.168.10.0/24`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- `PORTAL_SUNUCU` → `192.168.10.5`

**Firewall → Aliases → Ports**
- `RISKLI_PORTLAR` → `25`, `135`, `137:139`, `445`, `593`, `1900`, `3389`, `5353`, `853`

> `IC_AGLAR` içinde `192.168.0.0/16` var ve misafir ağı da onun içindedir; bu yüzden
> aşağıdaki 4. kuralda kaynak "MISAFIR net", hedef `IC_AGLAR` olarak yazılır ve
> **misafir-misafir** trafiği de kapanır (istenen davranış: bkz. §5 istemci izolasyonu).

### 2.4 Güvenlik duvarı kuralları (Firewall → Rules → MISAFIR)

| # | Action | Proto | Source | Destination | Port | Açıklama |
|---|---|---|---|---|---|---|
| 1 | Pass | UDP | MISAFIR net | MISAFIR address | 67, 68 | DHCP |
| 2 | Pass | TCP/UDP | MISAFIR net | MISAFIR address | 53 | DNS — sadece ağ geçidi |
| 3 | Pass | TCP | MISAFIR net | `PORTAL_SUNUCU` | 3000 (saha: 443) | Captive portal + OTP |
| 4 | **Block** | any | MISAFIR net | `IC_AGLAR` | * | **İç ağ izolasyonu** |
| 5 | **Block** | any | MISAFIR net | This Firewall | * | Yönetim arayüzü kapalı |
| 6 | **Block** | TCP/UDP | MISAFIR net | any | `RISKLI_PORTLAR` | SMB/RDP/SMTP/DoT |
| 7 | Pass | any | MISAFIR net | any | * | İnternet (portal doğrulaması sonrası) |

Her kurala **Log** işaretini koyun (5651 için değil, teşhis için; asıl delil
backend'in `logs/5651_captive/` dosyalarıdır).

### 2.5 DNS zorlaması (misafir kendi DNS'ini kullanamasın)

**Firewall → NAT → Port Forward → Add** (MISAFIR arayüzü):
- Proto `TCP/UDP`, Source: MISAFIR net, Destination: **invert** `MISAFIR address`,
  Dest port `53` → Redirect target `127.0.0.1`, port `53`
- Description: `DNS zorlamasi — 8.8.8.8 yazan misafir de bize duser`

Ek olarak:
- **DoT** (DNS over TLS) 853 zaten 6. kuralda kapalı.
- **DoH** (DNS over HTTPS) 443 üzerinden gider, port ile kapanmaz → pfBlockerNG'nin
  DoH sağlayıcı listesiyle alan adı seviyesinde engellenir (§2.6).

### 2.6 pfBlockerNG — içerik/DNSBL filtresi

1. **System → Package Manager** → `pfBlockerNG-devel` kurun.
2. **Firewall → pfBlockerNG → DNSBL** → Enable DNSBL, DNSBL Mode: `Unbound python`.
3. **DNSBL Groups** → şu kategorileri ekleyin (ücretsiz, restoran senaryosu için yeterli):
   - Kötü amaçlı yazılım / phishing (ör. `abuse.ch`, `Spamhaus DROP`)
   - Reklam/izleyici listeleri (misafir deneyimini de iyileştirir)
   - Yetişkin içerik (aile restoranı için — müşteriyle **yazılı olarak** kararlaştırın)
   - **DoH sağlayıcıları** listesi → misafirin DNS zorlamasını atlamasını engeller
4. **Update frequency**: günde 1 kez yeterli.
5. **Permit list**: müşterinin kendi alan adı, ödeme sağlayıcısı, sipariş uygulamaları —
   yanlış pozitif restoranın işini durdurur.

> **Yasal not:** filtreleme 5651 yükümlülüğünün yerine geçmez; loglama yine
> zorunludur. Filtreleme kapsamını (özellikle "yetişkin içerik") müşteriyle
> yazılı mutabakata bağlayın.

### 2.7 Captive portal + RADIUS

**Services → Captive Portal → MISAFIR zone**
- Enable, Interface `MISAFIR`, Idle timeout `30`, Hard timeout `120` (dk)
- Authentication: **RADIUS**
  - Primary auth server: `192.168.10.5`, port `1812`,
    shared secret: `<RADIUS_SECRET_DEGERINIZ>` (`backend/.env` → `RADIUS_SECRET` ile birebir aynı)
  - Accounting: **açık**, server `192.168.10.5`, port `1813`
  - **Accounting updates: interim (stop/start değil)** — `Acct-Interim-Interval 300`.
    Veri kotası (F-10) **yalnızca interim update'lerle** çalışır; kapalıysa kota hiç tetiklenmez.
- **Allowed IP Addresses** sekmesi: `192.168.10.5` (doğrulama öncesi portal erişimi)
- Portal sayfası: `pfsense-files/portal-page.html`, hata sayfası: `pfsense-files/hata.html`

**CoA / Disconnect (RFC 5176):** kotayı aşan misafiri düşürmek için ağ geçidi
UDP `3799`'u dinlemelidir. pfSense'te bu, captive portal RADIUS ayarlarındaki
disconnect/CoA seçeneğine bağlıdır ve **sürümden sürüme değişir** — kurulumdan sonra
şu testle doğrulayın (§6.5). Desteklenmiyorsa kota yine de çalışır: oturum
accounting'de kapatılır ve misafir `Session-Timeout` dolunca düşer; anlık atma olmaz.

### 2.8 Syslog yönlendirme (5651 delili)

**Status → System Logs → Settings**
- Enable Remote Logging, Remote log server: `192.168.10.5:514`
- Gönderilecekler: **Firewall events** + **DNS (Resolver)** — backend `filterlog` ve
  `unbound` biçimlerini ayrıştırır (`backend/syslog-server.js`).
- Kaynak arayüz: iç ağ (LAN), misafir arayüzü **değil**.

---

## 3. MikroTik (RouterOS 7) — aynı kuralların komut karşılığı

> Aşağıdaki komutlar kopyala-yapıştır içindir; `<RADIUS_SECRET_DEGERINIZ>` ve
> arayüz adlarını kendi kurulumunuza göre değiştirin. **Önce yedek alın:**
> `/system backup save name=misafir-oncesi`

### 3.1 VLAN, adres, DHCP

```
/interface vlan add name=vlan20-misafir vlan-id=20 interface=bridge-lan
/ip address add address=192.168.20.1/24 interface=vlan20-misafir
/ip pool add name=misafir-pool ranges=192.168.20.100-192.168.20.200
/ip dhcp-server add name=misafir-dhcp interface=vlan20-misafir address-pool=misafir-pool lease-time=2h disabled=no
/ip dhcp-server network add address=192.168.20.0/24 gateway=192.168.20.1 dns-server=192.168.20.1
```

### 3.2 Adres listeleri

```
/ip firewall address-list add list=IC_AG address=192.168.10.0/24 comment="Kasa/POS/NAS"
/ip firewall address-list add list=IC_AG address=10.0.0.0/8
/ip firewall address-list add list=IC_AG address=172.16.0.0/12
/ip firewall address-list add list=PORTAL address=192.168.10.5
```

### 3.3 Güvenlik duvarı (sıra önemli — `place-before` ile başa alın)

```
# 1-2) Ağ geçidine yalnızca DHCP + DNS
/ip firewall filter add chain=input in-interface=vlan20-misafir protocol=udp dst-port=67,68 action=accept comment="Misafir DHCP"
/ip firewall filter add chain=input in-interface=vlan20-misafir protocol=udp dst-port=53 action=accept comment="Misafir DNS"
/ip firewall filter add chain=input in-interface=vlan20-misafir protocol=tcp dst-port=53 action=accept comment="Misafir DNS/TCP"
# 5) Yönetim erişimi yok (winbox 8291, ssh 22, web 80/443)
/ip firewall filter add chain=input in-interface=vlan20-misafir action=drop comment="Misafir -> yonetim YASAK"

# 3) Portal sunucusuna doğrulama öncesi erişim
/ip firewall filter add chain=forward in-interface=vlan20-misafir dst-address-list=PORTAL protocol=tcp dst-port=3000 action=accept comment="Captive portal"
# 4) EN KRİTİK: misafir -> iç ağ yasak
/ip firewall filter add chain=forward in-interface=vlan20-misafir dst-address-list=IC_AG action=drop comment="Misafir -> ic ag YASAK"
# 6) Riskli portlar
/ip firewall filter add chain=forward in-interface=vlan20-misafir protocol=tcp dst-port=25,135,139,445,593,3389,853 action=drop comment="SMB/RDP/SMTP/DoT"
/ip firewall filter add chain=forward in-interface=vlan20-misafir protocol=udp dst-port=137,138,1900,5353,853 action=drop comment="NetBIOS/SSDP/mDNS/DoQ"
```

### 3.4 DNS zorlaması

```
/ip firewall nat add chain=dstnat in-interface=vlan20-misafir protocol=udp dst-port=53 action=redirect to-ports=53 comment="DNS zorlamasi"
/ip firewall nat add chain=dstnat in-interface=vlan20-misafir protocol=tcp dst-port=53 action=redirect to-ports=53
/ip dns set allow-remote-requests=yes servers=1.1.1.1,9.9.9.9
```

Alan adı engelleme (pfBlockerNG karşılığı — statik DNS ile):

```
/ip dns static add name=ornek-engelli-alan.com address=0.0.0.0 comment="DNSBL"
```

> RouterOS'ta hazır kategori listesi yoktur; liste bazlı engelleme için script ile
> periyodik indirme gerekir. Kapsamlı filtreleme isteniyorsa **pfSense + pfBlockerNG
> tercih edin** — bu projenin saha kurulumu pfSense üzerine planlanmıştır.

### 3.5 Hotspot + RADIUS + CoA

```
/ip hotspot setup                     # arayüz: vlan20-misafir, adres havuzu: misafir-pool
/radius add service=hotspot address=192.168.10.5 secret=<RADIUS_SECRET_DEGERINIZ> authentication-port=1812 accounting-port=1813 timeout=3s
/ip hotspot profile set [find] use-radius=yes radius-interim-update=5m
/radius incoming set accept=yes port=3799          # F-10: kota asiminda Disconnect kabul
/ip firewall filter add chain=input protocol=udp dst-port=3799 src-address=192.168.10.5 action=accept place-before=0 comment="RADIUS CoA — sadece portal sunucusu"
```

### 3.6 Syslog

```
/system logging action add name=portal-syslog target=remote remote=192.168.10.5 remote-port=514 src-address=192.168.10.1
/system logging add topics=firewall action=portal-syslog
/system logging add topics=dns action=portal-syslog
/system logging add topics=hotspot action=portal-syslog
```

---

## 4. Kapatılacak/açılacak portların özeti

| Port | Karar | Gerekçe |
|---|---|---|
| 53 UDP/TCP | Yalnızca ağ geçidine | DNS zorlaması — 5651 için DNS kaydı bizde olmalı |
| 67/68 UDP | İzin | DHCP |
| 80/443 TCP | İzin (doğrulama sonrası) | Normal gezinme |
| 3000 TCP (saha: 443) | Yalnızca portal sunucusuna | Captive portal, OTP |
| 25 TCP | **Kapalı** | Misafir cihazından spam gönderimi (IP itibarı) |
| 135, 137-139, 445 | **Kapalı** | SMB/NetBIOS — solucan ve dosya paylaşımı |
| 3389 TCP | **Kapalı** | RDP — iç ağa sıçrama denemeleri |
| 23 TCP | **Kapalı** | Telnet |
| 853 TCP/UDP | **Kapalı** | DoT — DNS zorlamasını atlar |
| 1900, 5353 UDP | **Kapalı** (VLAN dışına) | SSDP/mDNS — cihaz keşfi sızıntısı |
| 1812/1813 UDP | Yalnızca ağ geçidi → portal sunucusu | RADIUS |
| 514 UDP | Yalnızca ağ geçidi → portal sunucusu | Syslog |
| 3799 UDP | Yalnızca portal sunucusu → ağ geçidi | CoA/Disconnect (F-10) |

---

## 5. İstemci izolasyonu (misafir ↔ misafir)

Aynı Wi-Fi'daki iki misafirin birbirini görmesi engellenmelidir; aksi hâlde bir
misafir diğerinin telefonuna tarama yapabilir.

- **Erişim noktasında:** "Client Isolation" / "AP Isolation" / "Guest Mode" açın
  (üreticiye göre isim değişir). En doğru yer burasıdır — trafik ağ geçidine hiç çıkmaz.
- **MikroTik köprüde:** `/interface bridge port set [find interface=wlan-misafir] horizon=1`
  — aynı horizon değerine sahip portlar birbirine trafik iletmez.
- **pfSense'te:** misafir alt ağı içi trafik ağ geçidinden geçmediği için kural
  yazılamaz; izolasyon **AP tarafında** yapılmak zorundadır.

---

## 6. Kurulum sonrası doğrulama (her maddeyi bizzat deneyin)

Misafir ağına bir telefon/laptop bağlayın ve sırayla:

1. **Portal açılıyor mu?** Tarayıcıda herhangi bir HTTP adresi → portal sayfası gelmeli.
   Gelmiyorsa: 3. kural veya "Allowed IP Addresses" eksik.
2. **İç ağ gerçekten kapalı mı?**
   ```bash
   ping 192.168.10.5          # yanıt GELMEMELİ (portal 3000 hariç)
   nmap -Pn 192.168.10.0/24   # tüm hostlar kapalı görünmeli
   ```
   Yanıt geliyorsa 4. kural yanlış sırada — yukarı taşıyın.
3. **DNS zorlaması çalışıyor mu?**
   ```bash
   nslookup ornek.com 8.8.8.8   # yanıt yine de AĞ GEÇİDİNDEN gelmeli
   ```
   Yanıt gerçekten 8.8.8.8'den geliyorsa NAT redirect kuralı devrede değil.
4. **5651 logu doluyor mu?** Birkaç site gezin, sonra portal sunucusunda:
   ```bash
   tail -5 backend/logs/5651_captive/$(date +%F).log
   ```
   Satırlarda **telefon numarası çözülmüş** olmalı (`BILINMEYEN_TEL` değil).
   `BILINMEYEN_TEL` görüyorsanız: accounting açık değil ya da syslog'daki IP,
   RADIUS oturumundaki IP ile eşleşmiyor.
5. **Kota/CoA çalışıyor mu?** (F-10) Portal sunucusunda `QUOTA_MB` değerini geçici
   olarak `2` yapıp sunucuyu yeniden başlatın, misafirden ~3 MB indirin. Sunucu logunda
   şunu görmelisiniz:
   ```
   [QUOTA] <mac> kotayi asti (3.0 MB / 2 MB). Oturum kapatiliyor: <session>
   [QUOTA] NAS Disconnect-ACK dondu — <mac> agdan dusuruldu.
   ```
   `Disconnect-ACK` yerine zaman aşımı görüyorsanız ağ geçidi 3799'u dinlemiyordur
   (MikroTik: `/radius incoming print`).
6. **Yönetim arayüzü kapalı mı?** Misafir ağından `https://192.168.20.1` ve
   `192.168.10.1` → **açılmamalı**.

---

## 7. Sık yapılan hatalar

- **DHCP aralığı ile `backend/.env` uyuşmuyor** → `LAN_PREFIX`/`LEASE_START`/`LEASE_END`
  farklıysa 5651 logunda IP→telefon eşlemesi tutmaz.
- **RADIUS sırrı iki tarafta farklı** → sessizce Access-Reject; loga bakmadan anlaşılmaz.
- **`192.168.0.0/16` blok kuralı portal sunucusunu da kapsıyor** → portal açılmaz;
  portal izin kuralı blok kuralının **üstünde** olmalı.
- **Accounting kapalı** → oturum kaydı yok, kota çalışmaz, 5651 delili eksik kalır.
- **IPv6 açık unutulmuş** → IPv4 kuralları atlanır; misafir arayüzünde IPv6'yı kapatın.
- **Anti-lockout kuralı** pfSense'te LAN içindir; misafir arayüzünde yönetim erişimini
  kapatmak sizi kilitlemez, ama kuralı **LAN'da** denemeyin.

---

## 8. İlgili belgeler

- `docs/GUVENLIK-DEGERLENDIRMESI.md` — bu kural setinin neden gerektiği (§1)
- `docs/SIMULASYON-REHBERI.md` — pfSense VM ile donanımsız deneme ortamı
- `docs/WIRESHARK-REHBERI.md` — RADIUS/syslog paketlerini gözlemleme
- `README.md` — saha kurulum adımları ve TLS sertifikası üretimi
