# Güvenlik Değerlendirmesi — wifi-system

**Tarih:** 2026-08-29 · **Kapsam:** `backend/` (Node tarafı), `pfsense-files/`, mimari
**Yöntem:** kaynak kod okuması. Dinamik test / sızma testi yapılmadı.

Bu belge iki işe yarar: (1) sahaya çıkmadan önce kapatılması gereken açıklar,
(2) vitrin README'sinde "neyi biliyorum, neyi bilerek yapmadım" bölümünün kaynağı.
Bir mülakatçının soracağı her soru aşağıda zaten cevaplanmış oluyor.

---

## 0. ÖZET TABLO

> **DÜZELTME DURUMU (2026-09-01):** Kod seviyesi bulguların tamamı (F-01…F-09) ve
> okuma sırasında yeni bulunan F-12 kapatıldı. Her düzeltme `npm run attack` /
> `npm run verify-chain` / `npm run test:esp32` ile kanıtlandı. Önce/sonra çıktısı:
> `docs/attack-before.txt` (4 açık) → `docs/attack-after.txt` (0 açık).
> F-10 (veri kotası) ve F-11 (pfSense kural seti) bir sonraki partiye bırakıldı
> (yeni özellik/altyapı işi). Not: aşağıdaki satır numaraları düzeltme ÖNCESİ koda aittir.

| # | Bulgu | Şiddet | Durum |
|---|---|---|---|
| 1 | OTP brute-force mümkün: deneme sayısı sınırı yok | **Kritik** | ✅ Kapatıldı — 5 deneme kilidi + verify hız sınırı |
| 2 | Rate limit istemci MAC'i ile atlatılabilir → SMS bombing | **Kritik** | ✅ Kapatıldı — anahtar IP+telefon, numara/gün tavanı |
| 3 | ESP32 yetkilendirme kimlik doğrulamasız HTTP GET | **Yüksek** | ✅ Kapatıldı — HMAC imzalı POST + replay koruması; **gerçek ESP32'de doğrulandı (2026-09-03)** |
| 4 | RADIUS şifresi = MAC → spoof ile oturum devralma | **Yüksek** | ✅ Kapatıldı — rastgele oturum sırrı |
| 5 | OTP `Math.random()` ile üretiliyor | **Orta-Yüksek** | ✅ Kapatıldı — `crypto.randomInt` + hash + sabit zaman |
| 6 | Portal HTTP; OTP/telefon düz metin | **Yüksek** (sahada) | ✅ Altyapı hazır — `TLS_ENABLED` (sahada zorunlu) |
| 7 | Kişisel veri `db.json`'da düz metin + süresiz | **Orta** | ✅ Kapatıldı — OTP hash, saklama temizliği; db.json gitignore |
| 8 | İmzalamada hash zinciri YOK | **Orta** (delil) | ✅ Kapatıldı — `previousHash` zinciri + doğrulayıcı |
| 9 | Bant genişliği öznitelikleri pakete konmuyor | **Düşük** (bilinçli) | ✅ Belgeleme düzeltildi (README) |
| 10 | Toplam veri kotası mekanizması yok | **Düşük** (eksik özellik) | ⏳ Sonraki parti |
| 11 | İçerik/site kısıtlaması yok | **Bilgi** (pfSense işi) | ⏳ Sonraki parti (pfSense kural seti) |
| 12 | Yönetim API'si kimlik doğrulamasız — log silinebiliyor | **Kritik** | ✅ Kapatıldı — oturum girişi; üretimde log silme kapalı |

**F-12 (okuma sırasında bulundu):** `/api/dashboard/*` uçlarının tamamı kimlik
doğrulamasızdı. `POST /api/dashboard/clear-logs` 5651 delil dosyalarını (`.log/.gz/.ts`)
siliyordu; `search` başka misafirlerin geçmişini telefon numarasıyla sorgulatıyordu.
Ağa bağlanan herhangi biri tek istekle delilleri yok edebilirdi — bu, kanunun tam
olarak korumaya çalıştığı şeydir. Çözüm: oturum tabanlı yönetici girişi (giriş sayfası +
HMAC imzalı çerez) + üretim modunda log silme API'sinin tamamen devre dışı bırakılması.

---

## 1. SORU: "Şunlar şuraya giremesin" gibi kısıtlama var mı?

**Hayır, hiçbir yerde yok.** Tüm kod tabanında blacklist / whitelist / DNS filtresi /
kategori engeli araması sonuçsuz. `filterlog` geçen yerler pfSense'in *log formatını*
taklit eden kodlar — engelleme değil, günlükleme.

**Bu bir hata değil, mimari sınır:** içerik filtreleme captive portal backend'inin işi
değildir, **ağ geçidinin** (pfSense) işidir. Doğru yeri şurası:

- **pfBlockerNG** — DNSBL ile kategori/liste bazlı alan adı engelleme
- **pfSense firewall kuralları** — port/protokol kısıtı (ör. misafir ağından SMB, SSH, torrent portlarını kapatmak)
- **DNS zorlaması** — misafirin kendi DNS'ini kullanmasını engelleyip yönlendirme
- **Misafir ağı izolasyonu** — misafir VLAN'ından iç ağa (kasa, POS, NAS) erişimin kesilmesi. Restoran senaryosunda **en kritik kural budur** ve şu an hiçbir yerde tanımlı değil.

**Aksiyon:** `pfsense-files/` altına bir `firewall-rules.md` (veya kural dışa aktarımı)
eklenmeli. Şu an repo "kimlik doğrularım ve loglarım" diyor, "misafiri sınırlarım" demiyor.

---

## 2. SORU: Rate limiting var mı?

**Var ama atlatılabilir.** `server.js:23-39`'da iki katman doğru kurulmuş:

- `smsLimiter` — 1 istek / dakika
- `smsHourlyLimiter` — 5 istek / saat

Sorun anahtar üretiminde:

```js
keyGenerator: (req) => (req.body && req.body.mac) || req.ip
```

MAC adresi **isteğin gövdesinden** geliyor, yani tamamen saldırganın kontrolünde.
Her istekte rastgele bir MAC göndererek her iki limit de sıfırlanır. Sonuç:

- **Maliyet saldırısı:** her SMS para. Sınırsız SMS tetiklenebilir.
- **Üçüncü şahsa SMS bombardımanı:** telefon numarası başına limit olmadığı için
  bir kurbanın numarasına farklı MAC'lerle sürekli kod yollatılabilir.

**Düzeltme:**
```js
keyGenerator: (req) => `${req.ip}:${(req.body && req.body.phone) || ''}`
```
Artı telefon numarası başına ayrı bir günlük tavan (ör. 10/gün). İstemciden gelen
hiçbir değer tek başına rate-limit anahtarı olamaz — genel kural.

### 2b. Daha kritiği: `/api/verify-otp` hiç rate limit'li değil

`server.js:162`'de doğrulama uç noktasında limit yok, `db.js:97`'de yanlış denemede
sayaç artmıyor, kilitleme yok, akış iptal edilmiyor — sadece `false` dönüyor.

6 haneli OTP = 1.000.000 olasılık. 3 dakikalık geçerlilik penceresinde saniyede birkaç
yüz istekle **brute-force edilebilir**. Bu, kimlik doğrulamayı doğrudan atlar.

**Düzeltme:** akış başına 5 yanlış deneme → akış iptal, yeni OTP zorunlu.
Ayrıca `/api/verify-otp`'a IP başına dakikada 10 istek limiti.

---

## 3. SORU: Hız / veri miktarı sınırlaması var mı?

**Kısmen — yazılıyor ama uygulanmıyor.**

Ne var (`db.js:110-118`): OTP doğrulanınca `radreply` profili oluşturuluyor ve içine
`Mikrotik-Rate-Limit` (`5M/2M`), `WISPr-Bandwidth-Max-Down/Up` (bit/s) ve
`Session-Timeout` yazılıyor. Yani **veri modeli doğru** — gerçek NAS'ın okuyacağı
öznitelikler doğru isimlerle üretiliyor.

Ne yok (`radius-server.js:33-41`): Access-Accept yanıtına yalnızca `Session-Timeout`
ve `Acct-Interim-Interval` konuyor. Bant genişliği öznitelikleri **pakete konmuyor**,
sadece log'a yazılıyor. Kodun kendi yorumu bunu açıkça söylüyor: satıcıya özel
(vendor-specific) öznitelikler sözlük gerektirdiği için simülasyonda atlanmış.

Bu **bilinçli ve savunulabilir** bir karar — ama README'de "hız limiti var" denemez.
Doğru cümle: *"hız limiti profili üretilir ve radreply'da tutulur; gerçek uygulaması
NAS tarafındadır, simülasyonda pakete kodlanmaz."*

**Toplam veri kotası (kaç GB) hiç yok.** Accounting ile `inputOctets`/`outputOctets`
sayılıyor (`radius-server.js:88-95`) ama hiçbir eşik kontrolü yapılmıyor.
Kota istenirse: interim-update'te toplamı kontrol et, eşik aşılınca RADIUS
**Disconnect-Message (CoA/DM)** gönder. Veri zaten toplanıyor, sadece karar katmanı yok.

**Süre sınırı çalışıyor:** `Session-Timeout: 7200` (2 saat) gerçekten gönderiliyor. ✓

---

## 4. SORU: İmzalama ve `.ts` dosyası tam olarak nasıl çalışıyor?

`kamusm-signer.js` her gece 23:59'da (`node-cron`) şunu yapıyor:

1. `logs/5651_captive/YYYY-MM-DD.log` okunur
2. **Gzip**'lenir → `.log.gz`
3. Sıkıştırılmış dosyanın **SHA-256** özeti alınır
4. RFC 3161 alanlarını taklit eden bir **JSON** üretilip `.ts` olarak yazılır

### Bilinmesi gereken üç şey

**(a) Bu gerçek bir zaman damgası değil, mock.** İmza satırı:

```js
signature: crypto.createHmac('sha256', 'kamusm_private_key_mock')
                 .update(sha256 + signingTime).digest('base64')
```

Anahtar **kodda gömülü sabit bir string**. Yani imzayı kod tabanını gören herkes
üretebilir — kriptografik bir kanıt değeri yok. SIM_MODE için tamamen makul, ama
"RFC 3161 imzalı" diye sunulamaz.

**(b) `.ts` uzantılı ama RFC 3161 formatında değil.** Gerçek TSA yanıtı DER kodlu
bir PKCS#7/CMS yapısıdır (`.tsr`), JSON değil. Gerçeği için: `.tsq` isteği üretilip
KamuSM TSA'ya HTTP POST edilir, dönen `.tsr` saklanır, doğrulama TSA'nın sertifikasıyla
yapılır (OpenSSL `ts` komutu).

**(c) Hash zinciri YOK — bunu vurgulamak gerekiyor.** Her gün bağımsız imzalanıyor;
bir günün kaydında **önceki günün hash'i geçmiyor.** Sonuç: bir günün log dosyasını
`.gz` ve `.ts` dosyalarıyla birlikte tamamen silersen, geriye kalan kayıtlar
kendi içinde tutarlı görünür — eksikliği kanıtlayacak bir bağ yok.

**Bu en değerli iyileştirme maddesi.** Çözümü ~20 satır: her günün imza kaydına
`previousHash` alanı eklenir, zincir başı (genesis) sabitlenir. O zaman sistem
"günlük damga" olmaktan çıkıp gerçek bir **delil zinciri** olur — ve 5651'in
"logların değiştirilemezliği" gereksinimini gerçekten karşılar.

---

## 5. SORU: Şifreleme ve çift taraflı haberleşme nasıl?

Akıştaki her bacak ayrı ayrı:

| Bacak | Taşıma | Durum |
|---|---|---|
| Misafir tarayıcısı → portal | HTTP (sim: `localhost:3000`) | ❌ **TLS yok** — sahada OTP ve telefon numarası düz metin uçar. Aynı Wi-Fi'daki biri dinleyebilir. Sahada portal mutlaka HTTPS olmalı. |
| Backend → NetGSM | **HTTPS** (`api.netgsm.com.tr`) | ✓ Doğru. Kimlik bilgileri XML gövdesinde gider (API'nin dayattığı biçim, alternatif yok). |
| NAS ↔ RADIUS | UDP + paylaşılan sır | ⚠️ RADIUS `User-Password` **şifrelenmez**, MD5 tabanlı XOR ile *gizlenir*. Diğer öznitelikler (MAC, IP, kullanım) düz metindir. Bu protokolün kendi zayıflığıdır; modern çözüm RadSec (TLS üzerinden RADIUS). |
| Backend → ESP32 | **HTTP GET, kimlik doğrulamasız** | ❌ En ciddi bulgulardan biri, aşağıda. |

### 5b. ESP32 yetkilendirme uç noktası (`server.js:206`)

```js
const url = `${config.esp32.apUrl}/authorize?mac=${encodeURIComponent(cleanMac)}`;
axios.get(url, { timeout: 3000 })
```

Bu istekte **hiçbir kimlik doğrulama yok**. Ağdaki herhangi biri tarayıcıdan
`http://192.168.4.1/authorize?mac=<kendi-mac>` çağırıp SMS doğrulaması yapmadan
internete çıkabilir — yani sistemin tüm amacı atlanır. Üstelik yetkilendirme
GET ile yapılıyor (durum değiştiren işlem GET olmamalı).

**Düzeltme:** paylaşılan bir sırla HMAC imzalı POST:
`POST /authorize` gövde `{mac, timestamp, nonce}` + `X-Signature: HMAC-SHA256(gövde, sır)`.
ESP32 tarafı imzayı ve zaman penceresini (replay koruması) doğrular.
**Bu tam senin alanın** — kriptografi dersinde öğrendiğin şeyin birebir uygulaması.

### 5c. RADIUS kimliği: şifre = MAC adresi (`db.js:105-108`)

```js
this.data.radcheck[cleanMac] = { username: cleanMac, password: cleanMac };
```

MAC adresi hem kullanıcı adı hem şifre. MAC gizli bir değer değildir — havada açıkça
yayınlanır ve kolayca taklit edilir (spoof). Doğrulanmış bir misafirin MAC'ini kopyalayan
biri onun oturumunu devralabilir; 5651 logunda **o kişinin telefon numarasıyla** kaydedilir.
Yani yanlış kişi hukuki olarak sorumlu görünür.

Kodda "captive portal simplification" notu var — sorunun farkında olunması iyi, ama
sahaya çıkmadan önce en azından rastgele üretilmiş bir oturum sırrına geçilmeli.

---

## 6. VERİ SAKLAMA / KVKK

- `db.json` düz metin: telefon numaraları, OTP'ler, oturum kayıtları. Diskte şifresiz.
- **OTP'ler hash'lenmeden saklanıyor** ve doğrulama `flow.otp === otp` ile yapılıyor
  (`db.js:100`) — sabit zamanlı karşılaştırma değil.
- **Public repoya açarken `db.json` kesinlikle `.gitignore`'da olmalı** —
  gerçek telefon numarası içerebilir.
- 5651 logları kişisel veridir: saklama süresi (2 yıl) sonunda otomatik silme
  mekanizması yok. Yasal gereklilik hem tutmak hem süresi dolunca silmektir.

---

## 7. ÖNCELİKLİ DÜZELTME SIRASI

Sahaya çıkma senaryosu için:

1. `/api/verify-otp`'a deneme sayacı + rate limit *(brute-force'u kapatır)*
2. Rate limit anahtarını istemci MAC'inden kurtar *(SMS maliyet saldırısı)*
3. ESP32 `/authorize` için HMAC imzalı POST + replay koruması
4. OTP üretimi `crypto.randomInt`, saklama hash'li, karşılaştırma `timingSafeEqual`
5. Portal HTTPS
6. RADIUS şifresi = MAC yerine rastgele oturum sırrı
7. İmzalamaya `previousHash` zinciri
8. pfSense kural seti: misafir VLAN izolasyonu + pfBlockerNG

Vitrin/portföy önceliği (mülakatta en çok konuşulacaklar): **1, 3, 4, 7.**

---

## 8. GENEL DEĞERLENDİRME

Mimari doğru kurulmuş: katmanlar ayrılmış (portal / RADIUS / accounting / syslog /
imzalama), gerçek protokoller gerçek portlarda konuşuyor, veri modeli standart RADIUS
öznitelik isimlerini kullanıyor, simülasyon ile saha modu tek bayrakla ayrılmış.
Bir junior portföyünde nadiren görülen olgunluk seviyesi bu.

Zayıf taraf tutarlı bir temada toplanıyor: **"mutlu yol" (happy path) eksiksiz,
kötü niyetli kullanıcı senaryosu düşünülmemiş.** Sistem doğru kullanan misafiri
kusursuz karşılıyor; kötüye kullanmak isteyeni durduracak katman yok.

Bu, projeyi zayıflatan bir şey değil — **bir sonraki sürümün yol haritası.**
Ve mülakatta anlatılacak en iyi hikâye tam olarak budur: "sistemi yazdım, sonra
saldırgan gözüyle okudum, şu 8 açığı buldum, şu sırayla kapattım."
