# wifi-system — Baştan Sona Proje Anlatımı

> Mülakat hazırlığı için. Her bölüm "ne yapıyor → kod → neden böyle → nasıl çalışıyor
> adım adım" düzeninde. Satır satır ezber değil, **mekanizmayı** anlamak için.

---

## 0. Bu proje neyi çözüyor?

Türkiye'de misafirine WiFi veren işletme, **5651 sayılı kanun** gereği "kim, ne zaman,
hangi siteye bağlandı"yı kaydetmek ve **değiştirilemez** biçimde saklamak zorundadır.
İki problem:

1. **Kimlik** — bağlanan kişi rastgele biri değil, telefonu doğrulanmış biri olmalı.
2. **Kayıt** — o kişinin trafiği zaman damgalı loglanmalı ve sonradan oynanamamalı.

Sistem: misafir telefon girer → SMS kod → kod doğru → internet açılır → tüm süreç
imzalı, hash zincirli loglanır.

**Tek cümle (mülakat):** *"Kısıtlı cihazda ve gerçek ağ protokolleriyle çalışan,
hukuki delil zinciri üreten bir kimlik doğrulama ve loglama sistemi."*

---

## 1. Oyuncular — kim kiminle konuşuyor?

| Aktör | Gerçekte | Kodda |
|---|---|---|
| Misafir | Telefon/laptop | `views/captive.html` (tarayıcı) |
| AP (Access Point) | WiFi yayan cihaz | `esp32-bridge.ino` |
| Ağ geçidi (Gateway/NAS) | Trafiği yönlendirir + loglar | pfSense/MikroTik (saha) — simülasyonda Node |
| RADIUS sunucusu | "Girebilir mi?" kararı | `radius-server.js` |
| Portal backend | Beyin | `server.js` + modüller |

Gerçekte bunlar ayrı makineler ve **ağ protokolleriyle** konuşur. Bu projenin değeri:
protokolleri taklit etmiyor, **gerçekten** konuşturuyor — RADIUS paketleri gerçek UDP
paketi olarak 1812/1813'ten, syslog 514'ten akar. Wireshark ile izlenebilir.

**RADIUS nedir?** Kurumsal/otel ağlarında "bu kullanıcı girebilir mi, ne hız/süre alır,
ne kadar veri harcadı" sorularını yanıtlayan endüstri standardı (AAA: Authentication,
Authorization, Accounting). Sen kendi RADIUS sunucunu yazdın.

---

## 2. Uçtan uca akış (bir misafir bağlanınca)

```
1. WiFi'ye bağlan                → ESP32 köprüsü
2. Portal açılır (telefon iste)  → GET /captive
3. Kod iste                      → POST /api/send-otp
4. SMS gider, kod gir            → POST /api/verify-otp
5. Kod doğru → RADIUS "kabul"    → radius-server.js (UDP 1812)
6. Oturum açılır (accounting)    → radius-server.js (UDP 1813)
7. Trafik loglanır               → syslog-server.js (UDP 514)
8. Gece log imzalanır            → kamusm-signer.js (cron 23:59)

   (kota açıksa) veri eşiği aşılır → RADIUS Disconnect (UDP 3799) → oturum kapanır
   (süre dolarsa) Session-Timeout  → oturum otomatik kapatılır
```

---

## 3. Kod haritası

```
backend/
├── server.js           BEYİN — tüm HTTP uçları, akış yönetimi
├── config.js           Ayarlar tek yerde (.env'den okur) + başlatma koruması
├── db.js               JSON dosyasına yazan basit "veritabanı" (atomik yazma)
├── auth.js             Yönetici girişi (scrypt parola, HMAC çerez, middleware)
├── validate.js         İstek gövdesi şema doğrulaması (her POST ucu için)
├── errors.js           Merkezi hata katmanı — tek biçimli JSON, stack sızmaz
├── radius-server.js    RADIUS sunucusu + veri kotası/CoA (UDP 1812/1813 → 3799)
├── radius-client.js    RADIUS istemcisi (simülasyonda NAS'ı taklit eder, CoA dinler)
├── syslog-server.js    Ağ geçidi loglarını 5651 formatına çevirir (UDP 514)
├── kamusm-signer.js    Günlük log imzalama + hash zinciri (cron)
├── netgsm.js           Gerçek SMS gönderimi (HTTPS)
├── simulate.js         Donanımsız uçtan uca demo sürücüsü
├── attack.js           Güvenlik saldırı testi
├── verify-chain.js     İmza zinciri doğrulayıcı (verifyChain() olarak da çağrılabilir)
├── scripts/gen-cert.js Kendinden imzalı TLS sertifikası üretir (npm run gen-cert)
└── test/               Birim + uç nokta testleri — `npm test` hepsini koşar
```

**Sonradan eklenen iki ince katman:** `validate.js` her POST ucunda beklenen alanları
şema olarak tanımlar (bozuk MAC/OTP/beklenmeyen alan → 400, iş mantığına hiç girmez);
`errors.js` ise fırlatılan her hatayı tek biçimli JSON'a çevirir ve yığın izini yalnızca
sunucu konsoluna yazar. İkisi de "girdiye güvenme, hatayı sızdırma" kuralının kod hâli.

Her modül tek iş yapar (separation of concerns): RADIUS'u değiştirmek portalı bozmaz.

---

## 4. config.js — her şeyin başladığı yer

Tüm ayarlar `.env`'den okunur. **Sırlar asla kodda yazmaz** — kod public, sırlar
`.env`'de, `.env` gitignore'da.

Kritik parça, **başlatma koruması** (fail-closed ilkesi):

```js
function assertProductionSecrets() {
  if (config.SIM_MODE) return;               // demoda esnek
  const missing = [];
  if (!config.admin.passwordHash) missing.push('ADMIN_PASSWORD_HASH');
  // ... diğer kritik sırlar
  if (missing.length) { console.error(...); process.exit(1); }  // BAŞLATMA
}
```

**Nasıl çalışıyor:** `server.js` daha ilk satırlarda `config.assertProductionSecrets()`
çağırır. Üretim modunda (`SIM_MODE=false`) yönetici parolası boşsa, sistem *sessizce boş
parolayla açılmak yerine* süreci `process.exit(1)` ile öldürür. İlke: yanlış
yapılandırmada sistem **kapalı** tarafa düşer (fail-safe), açık tarafa değil.

Demo modunda eksik sırlar geçici üretilir + her açılışta uyarı:

```js
function devSecret(label) {
  const v = crypto.randomBytes(24).toString('hex');
  console.warn(`UYARI: ${label} tanımlı değil — geçici üretildi (sahada KULLANMAYIN).`);
  return v;
}
```

---

## 5. OTP akışı — sistemin kalbi

### 5.1 Kod isteme: `POST /api/send-otp`

```js
app.post('/api/send-otp', validatePhone, phoneDailyLimiter, smsHourlyLimiter, smsLimiter, async (req, res) => {
```

Bu dizi **middleware zinciri**. Express'te istek soldan sağa bu fonksiyonlardan geçer;
biri yanıt döndürüp `next()` çağırmazsa zincir orada durur. Sıra kasıtlı:

1. `validatePhone` — numara `5XXXXXXXXX` mı? Değilse 400, dur.
2. `phoneDailyLimiter` — bu numaraya bugün çok kod gitti mi?
3. `smsHourlyLimiter`/`smsLimiter` — bu IP+numara son saatte/dakikada çok istedi mi?

**Neden bu sıra:** Doğrulama en başta, çünkü geçersiz numaraya limit sayacı harcamak
istemem. Sonra kod üretimi:

```js
const otpCode = crypto.randomInt(100000, 1000000).toString();
```

**Neden `Math.random` değil:** `Math.random()` tahmin edilebilir bir PRNG'dir (güvenlik
için değil hız için). Yeterli çıktı gören biri sonraki değerleri kestirebilir.
`crypto.randomInt` OS'un kriptografik entropi havuzunu kullanır, tahmin edilemez. OTP
tahmin edilebilirse tüm sistem çöker — saldırgan SMS beklemeden kodu üretir.

### 5.2 Rate limiter nasıl çalışıyor? (F-02)

`express-rate-limit` her anahtar için bir sayaç + zaman penceresi tutar. Kilit nokta
**anahtarın nasıl üretildiği**:

```js
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, max: 1,
  keyGenerator: (req) => `${clientKey(req)}|${digitsOnly(req.body.phone)}`
});
```

Eski açık: anahtar `req.body.mac` idi — yani **istemcinin gönderdiği** bir değer.
Saldırgan her istekte rastgele MAC yollayıp her seferinde yeni sayaç açtırıyordu, limit
işlevsizdi. Yeni anahtar gerçek IP + telefondur; ikisi de istemci keyfince
değiştiremeyeceği/değiştirse işe yaramayacak değerler.

**Genel kural (mülakatta söyle):** *İstemciden gelen hiçbir değer tek başına rate-limit
anahtarı olamaz.*

`clientKey` IPv6'yı /64 önekine indirir (tek kişinin milyonlarca IPv6 adresiyle limit
atlamasını zorlaştırır):

```js
function clientKey(req) {
  let ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (ip.includes(':') && !ip.includes('.')) ip = ip.split(':').slice(0, 4).join(':');
  return ip;
}
```

### 5.3 Kodu saklama: neden düz metin değil?

`db.js` → `createGuestFlow`:

```js
const salt = crypto.randomBytes(8).toString('hex');
const flow = { mac, phone, salt, otpHash: hashOtp(salt, otp), attempts: 0, lockedAt: null, ... };
```

```js
function hashOtp(salt, otp) {
  return crypto.createHash('sha256').update(salt + ':' + otp).digest('hex');
}
```

**Neden hash:** `db.json` sızarsa (çalınan disk, kaçan yedek) düz metin OTP'ler okunurdu.
Hash geri döndürülemez. **Neden salt:** salt olmadan aynı OTP → aynı hash; ayrıca 6 haneli
tüm kodların SHA-256'sını içeren "rainbow table" saniyede hazırlanır. Her akışa özel salt,
bu tabloları işe yaramaz kılar. (Burada asıl korumayı deneme limiti verir; hash+salt
"defense in depth" — katmanlı savunma.)

### 5.4 Doğrulama + deneme kilidi (F-01)

Eski açık: yanlış kodda sadece `false` dönüyordu, **deneme sayılmıyordu**. 6 hane = 1M
ihtimal; saniyede yüzlerce istekle 3 dk'da kaba kuvvetle kırılır.

```js
verifyGuestFlow(mac, otp) {
  const flow = [...this.data.guestFlows].reverse().find(f => f.mac === cleanMac && !f.verified);
  if (!flow)            return { ok: false, reason: 'no_flow' };
  if (flow.lockedAt)    return { ok: false, reason: 'locked' };
  if (flow.expiresAt <= now) return { ok: false, reason: 'expired' };

  const candidate = hashOtp(flow.salt, String(otp));
  if (!safeEqualHex(candidate, flow.otpHash)) {
    flow.attempts += 1;
    if (flow.attempts >= config.security.otp.maxAttempts) {   // 5
      flow.lockedAt = now;                                    // KİLİTLE
      return { ok: false, reason: 'locked', remaining: 0 };
    }
    return { ok: false, reason: 'bad_code', remaining: ... };
  }
  // doğru → oturum sırrı üret (5.6)
}
```

**Dönüş tipi neden nesne:** "yanlış kod" / "kilitlendin" / "süresi geçti" farklı
durumlar, `server.js` her birine farklı HTTP kodu döner:

```js
if (result.reason === 'locked')   return res.status(429)...  // Too Many Requests
if (result.reason === 'bad_code') return res.status(400)...  // kalan hakkı bildir
```

### 5.5 Sabit zamanlı karşılaştırma — timing attack (senin kripto alanın)

```js
function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);   // === DEĞİL
}
```

**Neden `===` değil:** Normal string karşılaştırması **ilk farklı karakterde durur**.
`"abc"==="xyz"` 1. harfte, `"abc"==="abx"` 3. harfte döner. Yani karşılaştırma süresi,
kaç karakterin doğru olduğunu **sızdırır**. Saldırgan cevap süresini µs hassasiyetle
ölçüp değeri karakter karakter çözebilir (timing attack). `timingSafeEqual` girdi ne
olursa olsun **aynı sürede** çalışır, sızıntıyı kapatır.

### 5.6 Oturum sırrı — MAC spoofing'i kapatma (F-04)

Eski açık: `radcheck[mac] = { username: mac, password: mac }` — RADIUS parolası MAC'in
kendisiydi. MAC gizli değildir (havada açık yayınlanır, kolayca taklit edilir). Birinin
MAC'ini kopyalayan onun oturumunu devralır ve trafiği **o kişinin telefonuyla** loglanır
— masum kişi suçlu görünür.

```js
const sessionSecret = crypto.randomBytes(16).toString('hex');  // 128-bit rastgele
flow.sessionSecret = sessionSecret;
this.data.radcheck[cleanMac] = { username: cleanMac, password: sessionSecret };
return { ok: true, sessionSecret };
```

Artık parola tahmin edilemez bir sır; **tarayıcıya gönderilmez**, backend↔RADIUS arasında
kalır. MAC taklit eden sırrı bilemez.

---

## 6. RADIUS — kim girebilir kararı

`radius-server.js` UDP 1812'de dinler. Access-Request gelince:

```js
const packet = radius.decode({ packet: msg, secret: SHARED_SECRET });
if (packet.code === 'Access-Request') {
  const checkRecord = db.getRadCheck(packet.attributes['User-Name']);
  if (checkRecord && checkRecord.password === packet.attributes['User-Password']) {
    responseCode = 'Access-Accept';
    responseAttributes = { 'Session-Timeout': 7200, 'Acct-Interim-Interval': 300 };
  } else {
    responseCode = 'Access-Reject';
  }
}
```

`SHARED_SECRET` RADIUS'un kendi güvenliği — istemci ve sunucu ortak sır bilir, paketler
bununla doğrulanır (`.env`'deki `RADIUS_SECRET`).

**Simülasyonda istemci kim:** `radius-client.js`. Gerçekte NAS (pfSense/MikroTik/ESP32);
simülasyonda Node kendi NAS'ını da oynar:

```js
if (config.SIM_MODE) {
  const radAuth = await radiusClient.authenticate(mac, result.sessionSecret);
  if (radAuth.accepted) {
    const sessionId = 'sim-' + crypto.randomBytes(4).toString('hex');
    await radiusClient.accountingStart(mac, leaseIp, sessionId);   // UDP 1813
  }
}
```

`accountingStart` → RADIUS'a "bu oturum başladı" der (5651 "bağlantı başlangıç zamanı").
`accountingUpdate` → harcanan baytı günceller. `accountingStop` → oturum kapanışı.

---

## 7. db.js — "veritabanı" nasıl çalışıyor?

Harici bir veritabanı (PostgreSQL vb.) yok; veri bir JSON dosyasında (`db.json`) tutulur
ve `Database` sınıfı onu belleğe okur, değişince geri yazar:

```js
// Önce geçici dosyaya yaz, sonra yerine taşı: yazma yarıda kesilse bile
// db.json ya eski ya yeni hâliyle bulunur, ASLA yarım kalmaz.
flush() {
  fs.writeFileSync(DB_TMP_PATH, JSON.stringify(this.data, null, 2), 'utf8');
  fs.renameSync(DB_TMP_PATH, DB_PATH);
}
```

`save()` doğrudan yazmaz: kısa bir pencerede (varsayılan 200 ms) biriken değişiklikleri
tek yazmaya toplar, kapanışta (exit/SIGINT/SIGTERM) bekleyeni boşaltır. Ölçüm: 20
misafirlik bir iş yükünde 120 mantıksal yazma → **1 diske yazma**. Dosya okunamıyorsa
üzerine YAZILMAZ; `db.json.bozuk-<zaman>` olarak kenara alınır — bozuk bir dosyanın
üstüne boş veritabanı yazmak, o ana kadarki oturum kayıtlarını (delili) yok ederdi.

Beş koleksiyon: `guestFlows` (OTP akışları), `radcheck`/`radreply` (RADIUS profilleri),
`radacct` (oturum kayıtları), `leases` (MAC↔IP eşlemesi = DHCP taklidi).

**Neden JSON dosyası, gerçek DB değil?** Simülasyon/demo için bilinçli sadelik: kurulum
gerektirmez, `npm install && node server.js` yeter. **Bedeli** (mülakatta dürüstçe söyle):
eşzamanlı yazımda yarış koşulu riski, ölçeklenemez, tüm veri belleğe sığmalı. Saha
sürümünde `radcheck/radacct` gerçekte pfSense'in MySQL'inde durur (`pfsense-files/radius.sql`).

`allocateIp(mac)` DHCP kirasını taklit eder — bir MAC'e havuzdan (`192.168.20.100-200`)
sabit IP verir, aynı MAC tekrar gelince aynı IP döner. 5651 için MAC↔IP↔telefon zincirinin
halkası budur: log'da IP görürsün, IP→MAC→telefon diye kime ait olduğunu çözersin
(`getPhoneByIp`).

**Havuz dolarsa ne olur?** Bir dönem burada gerçek bir hata vardı: havuz tükenince her
yeni cihaza havuzun ilk adresi (`.100`) veriliyordu; onlarca cihaz aynı IP'yi paylaşınca
"bu IP o an kimdi?" sorusu — yani logun tek işi — belirsizleşiyordu. Artık aktif oturumu
olmayan bir kira geri alınır (gerçek DHCP'nin yaptığı), gerçekten yer yoksa yüksek sesle
loglanır. Aynı IP'de birden fazla aktif oturum varsa `getPhoneByIp` **en son** oturumu
esas alır.

**Saklama temizliği (F-07):** `purgeExpired()` süresi geçmiş doğrulanmamış akışları ve
saklama süresini (5651: 730 gün) aşan oturumları siler. Yasa hem tutmayı hem süre dolunca
silmeyi ister.

**Oturum ömrü:** `expireStaleSessions()` `Session-Timeout` süresi dolmuş oturumları
kapatır (bitiş zamanı olarak "fark edilen an" değil, sürenin dolduğu an yazılır). Sahada
bunu NAS yapar; simülasyonda kimse yapmayınca panelde hiç bitmeyen "aktif" misafirler
birikiyordu.

---

## 8. syslog-server.js — trafik nasıl "yasal kayda" dönüşüyor?

Gerçek ağ geçidi (pfSense/MikroTik) her DNS sorgusunu ve bağlantıyı **syslog** protokolüyle
UDP 514'e yollar. Bu sunucu onları dinler, ayrıştırır, 5651 formatında bir satıra çevirir:

```
<zaman> <IP> <MAC> <telefon> <hedef-domain/IP> <port>
```

Ayrıştırıcı iki tür satır tanır:
- **unbound** (DNS): "şu IP şu domaini sordu"
- **filterlog** (NAT/bağlantı): "şu IP şu hedefe şu porttan bağlandı"

Kilit iş: ham log'da sadece IP var; sunucu `db.getPhoneByIp(ip)` ile IP'yi **telefona**
bağlar. Böylece log "192.168.20.105 → trendyol.com" değil, "+90 5xx... → trendyol.com"
olur — 5651'in istediği kimlikli kayıt. Satır günlük dosyaya yazılır:
`logs/5651_captive/YYYY-MM-DD.log`.

---

## 9. kamusm-signer.js — hash zinciri (delilin değiştirilemezliği, F-08)

Her gece 23:59'da bir cron görevi çalışır:

```js
cron.schedule(config.kamusm.signHour, () => { signDailyLog(today); purgeOldLogs(); });
```

`signDailyLog` dört iş yapar:

1. Günün `.log`'unu **gzip**'ler → `.log.gz`
2. Sıkıştırılmış dosyanın **SHA-256**'sını alır
3. Önceki günün zincir bağını bulur ve bu günü ona **bağlar**:
   ```js
   const previousHash = previousChainHash(chain, dateStr);           // önceki günün chainHash'i
   const chainHash = sha256(previousHash + sha256 + signingTime);    // bu günün bağı
   ```
4. `.ts` damga dosyasına yazar (mock HMAC imza + `previousHash` + `chainHash`)

**Neden zincir hayati:** Zincir olmasa her gün bağımsız imzalanır. Bir günü tamamen
silersen (log+gz+ts üçlüsü), kalanlar kendi içinde tutarlı görünür — eksikliği kanıtlayan
hiçbir iz yok. Zincirde ise her gün bir öncekinin özetini taşır: bir günü silmek/değiştirmek
sonraki günün `previousHash` beklentisini bozar. Bu, sistemi "günlük damga"dan gerçek
**delil zincirine** (blockchain'in aynı temel fikri) çevirir.

**Dürüstlük notu:** İmza gerçek RFC 3161 TSA yanıtı DEĞİL, `config.kamusm.mockKey` ile
üretilen mock HMAC (`"mock": true` işaretli). Zincir yapısı gerçek. Sahada burası KamuSM
TSA'ya `.tsq` gönderip `.tsr` saklamalı.

`verify-chain.js` bunu doğrular: her `.log.gz`'nin hash'ini yeniden hesaplar (içerik
değişmiş mi?) ve zincir bağlarını kontrol eder (gün silinmiş mi?). İlk kopmayı bildirir.

---

## 10. auth.js — yönetici girişi (F-12)

Panel (`/dashboard`) 5651 kayıtlarına ve misafir geçmişine erişir; kimlik doğrulamasız
olamaz. Harici kütüphane olmadan üç parça:

**Parola — scrypt:**
```js
function verifyPassword(password, stored) {          // stored: "scrypt$salt$hash"
  const [, salt, expectedHex] = stored.split('$');
  const derived = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(derived, Buffer.from(expectedHex, 'hex'));
}
```
scrypt **kasıtlı yavaş** ve bellek-yoğun bir hash — kaba kuvveti pahalı kılar (parola
hash'lemede SHA-256'dan bu yüzden üstündür). Karşılaştırma yine sabit zamanlı.

**Oturum jetonu — HMAC imzalı çerez:**
```js
function issueToken(user) {
  const payload = `${user}|${exp}|${nonce}`;
  const sig = crypto.createHmac('sha256', config.admin.sessionSecret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}
```
Çerez `veri.imza` biçiminde. Kullanıcı çerezi kurcalarsa imza tutmaz. `verifyToken` önce
imzayı sabit zamanlı doğrular, sonra son kullanmayı kontrol eder. Sunucu tarafında oturum
tablosu tutmaya gerek yok — jeton **kendini doğrular** (stateless). JWT'nin sadeleştirilmiş
hali; mantığı birebir aynı.

**Middleware:**
```js
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) { req.adminUser = session.user; return next(); }
  const isApi = (req.originalUrl || '').startsWith('/api/');
  return isApi ? res.status(401).json({...}) : res.redirect('/login');
}
```
`server.js`'te tek satırla tüm panel korunur:
```js
app.use('/api/dashboard', auth.requireAuth);   // altındaki tüm uçlar otomatik korunur
```
Ek koruma: `clear-logs`/`reset` yalnızca `SIM_MODE`'da çalışır — **üretimde 5651 logu API
ile silinemez** (kanunun asıl istediği).

> **originalUrl inceliği:** `app.use('/api/dashboard', ...)` içinde `req.path` mount'a
> görelidir (`/clear-logs`), tam yolu değil. API tespiti için `req.originalUrl` kullanılır
> — yoksa API isteği 401 yerine 302 login yönlendirmesi alır, dashboard'ın fetch'leri bozulur.

---

## 11. esp32-bridge.ino — imzalı yetkilendirme (F-03)

ESP32 iki iş yapar: (1) şeffaf WiFi köprüsü (SoftAP), (2) backend'den gelen **HMAC imzalı**
yetkilendirme isteklerini doğrular.

Backend OTP doğrulanınca şunu yollar (`server.js` → `notifyEsp32Authorize`):
```js
const payload = JSON.stringify({ mac, ts, nonce });
const signature = crypto.createHmac('sha256', config.esp32.sharedSecret).update(payload).digest('hex');
await axios.post(`${apUrl}/authorize`, payload, { headers: { 'X-Signature': signature } });
```

ESP32 tarafı (C++), üç katmanlı doğrulama:
```cpp
// 1) İmza: gövdeyi paylaşılan sırla yeniden HMAC'le, SABİT ZAMANLI karşılaştır
if (sig.length() == 0 || !constEq(sig, hmacHex(body))) { send(401,"bad_signature"); return; }
// 2) Replay: aynı nonce daha önce görüldü mü? (son 16 nonce halka tamponunda)
if (nonceSeen(nonce)) { send(401,"replay"); return; }
// 3) Stale: zaman damgası kabul edilen en son ts'ten belirgin eski mi?
if (lastAcceptedTs > 0 && ts < lastAcceptedTs - CLOCK_TOLERANCE_SEC) { send(401,"stale"); return; }
```

**Neden bu üçü:**
- **İmza** — sırrı bilmeyen (yani gerçek backend olmayan) kimse geçerli istek üretemez.
  Eski açık: uç nokta imzasız GET'ti; ağdaki herkes `/authorize?mac=kendi` çağırıp SMS'siz
  içeri girebiliyordu (F-03).
- **Nonce (replay koruması)** — saldırgan geçerli bir imzalı isteği yakalayıp **aynen tekrar
  gönderemesin**. Her nonce bir kez kabul edilir.
- **Stale** — çok eski bir isteğin tekrarı reddedilir. NTP/RTC olmadığı için mutlak saat
  bilinmez; monoton ts + nonce birlikte replay'i kapatır.

`constEq` yine sabit zamanlı — imza karşılaştırmasında timing attack'a karşı.

`mbedtls/md.h` ESP32'nin donanım hızlandırmalı kripto kütüphanesi; HMAC-SHA256'yı burada
hesaplar. `secrets.h` (gitignore'da) backend `.env`'deki `ESP32_SHARED_SECRET` ile **aynı**
olmalı, yoksa imzalar tutmaz.

**Dürüst sınır:** ESP32 köprü modunda L2 trafiğini donanımda geçirir; izin listesi fiili
trafik engellemesi yapmaz — asıl uygulama ağ geçidinin işidir. Amaç, yetkilendirme
kanalının imzalı ve replay'e kapalı olması.

**Donanım doğrulaması (2026-09-03):** Firmware gerçek ESP32'ye yüklendi ve laptop AP ağına
bağlanıp `esp32-hw-test.js` çalıştırıldı. Beş testin beşi geçti: imzalı istek 200, imzasız
ve bozuk imza 401, replay (aynı nonce) ikinci gönderimde 401. Yani imza + replay koruması
"kodda öyle yazıyor" değil, **gerçek donanımda çalışıyor** (`docs/esp32-hw-test-sonuc.txt`).

---

## 12. Kanıt araçları — "yaptım" değil "test ettim"

- **`npm test`** — ek bağımlılık olmadan (Node'un kendi `node --test` koşucusu) 150'den
  fazla test: `db.js` (OTP hash'i, kilit, saklama, kira havuzu), `auth.js` (scrypt, HMAC
  jeton), `kamusm-signer.js` + `verify-chain.js` (zincirin bozulma senaryoları),
  `validate.js`, `errors.js`, `netgsm.js` (ağa hiç çıkmadan), `syslog-server.js`
  (5651 satır biçimi birebir) ve gerçek bir Express sunucusuna atılan HTTP uç nokta
  testleri. **Testler gerçek `db.json` ve `logs/` içeriğine asla dokunmaz** — `fs`
  katmanı kum havuzuna yönlendirilir (`test/_sandbox.js`).
- **attack.js** — her açığı saldırgan gibi dener; düzeltmeden önce "GEÇTİ (açık var)",
  sonra "ENGELLENDİ" der. Çıktı: `docs/attack-before.txt` vs `docs/attack-after.txt`.
  Kota açıkken A8 senaryosu, kotayı aşan misafirin gerçekten düşürüldüğünü de sınar.
- **verify-chain.js** — imza zincirini doğrular; bir günü silersen "zincir kopuk", içeriği
  değiştirirsen "içerik değiştirilmiş" der.
- **test/esp32-auth-sim.test.js** — ESP32 doğrulama mantığını JS'te yansıtıp sınar (imza/replay/
  stale). Donanımsız protokol kanıtı; `npm run test:esp32` ile tek başına da koşar.

Bir portföyde asıl fark yaratan budur: "sistemi yazdım" değil, "kırmayı denedim, şu açıkları
buldum, kapattım, kapandığını test ettim".

---

## 13. Simülasyon vs gerçek saha — ne değişir?

Bu proje hâlâ **simülasyon aşamasında**. Node hem portalı hem ağ geçidini hem RADIUS'u
tek makinede oynuyor. Gerçek sahada roller ayrı donanıma dağılır:

| Katman | Simülasyon (şimdi) | Gerçek saha |
|---|---|---|
| AP (WiFi yayını) | ESP32 SoftAP köprüsü | ESP32 veya kurumsal AP |
| Ağ geçidi + NAS | Node (`radius-client` NAS'ı taklit eder) | **MikroTik / pfSense** — trafiği yönlendirir, RADIUS'a sorar, hız/kota uygular, syslog üretir |
| RADIUS sunucusu | `radius-server.js` | FreeRADIUS (pfSense üstünde) + MySQL |
| Veri | `db.json` | MySQL (`pfsense-files/radius.sql` şeması) |
| Hız limiti | profil üretilir ama pakete kodlanmaz | NAS gerçekten uygular (Mikrotik-Rate-Limit) |
| Veri kotası | RADIUS sunucusu eşiği aşanı tespit eder ve **gerçek RFC 5176 Disconnect** gönderir; NAS'ı yine Node oynar | Aynı paket gerçek NAS'ın 3799 portuna gider, kullanıcıyı o düşürür |
| Portal TLS | varsayılan kapalı; `npm run gen-cert` ile açılabilir | zorunlu (gerçek CA sertifikası) |
| İmza | mock HMAC | KamuSM TSA (`.tsq`/`.tsr`) |

**Neden MikroTik/pfSense şart:** ESP32 sadece köprüdür — trafiği fiilen kesip
yönlendiremez, hız limiti/kota uygulayamaz, gerçek NAT/filterlog üretemez. O işi yapan
**gerçek bir NAS**'tır (MikroTik RouterOS ya da pfSense). Node bu NAS'ı simülasyonda taklit
ediyor; sahada yerini gerçek cihaz alır. Yani ESP32 "AP katmanı" kanıtı, Node ise "gateway
+ RADIUS" kanıtı — saha sürümünde ikincisi MikroTik/pfSense'e taşınır.

**Mülakatta konumlandırma:** *"Uçtan uca mimariyi tasarladım ve gerçek protokollerle
simülasyonda doğruladım; saha dağıtımında ağ geçidi katmanı MikroTik/pfSense'e, imzalama
KamuSM TSA'ya taşınır — arayüz aynı kalır çünkü standart RADIUS/syslog kullandım."*

---

## 14. Mülakat cep kılavuzu (30 saniyelik cevaplar)

- **"Bu ne?"** → 5651 uyumlu misafir WiFi kimlik doğrulama + delil loglama sistemi;
  kendi RADIUS ve syslog sunucularımı, SMS-OTP akışını ve hash zincirli imzalamayı yazdım.
- **"En zor kısım?"** → Delilin değiştirilemezliği. Bağımsız günlük damga yetmiyor;
  previousHash zinciriyle bir günün silinmesini bile tespit edilebilir hale getirdim.
- **"Güvenliği nasıl düşündün?"** → Sistemi yazdıktan sonra saldırgan gözüyle okudum,
  otomatik saldırı testi yazdım; OTP kaba kuvvet, SMS bombalama, MAC spoof, imzasız
  yetkilendirme ve kimlik doğrulamasız log silme açıklarını buldum ve kapattım.
- **"Kripto nerede?"** → OTP hash+salt, sabit zamanlı karşılaştırma (timing attack),
  RADIUS oturum sırrı, HMAC imzalı ESP32 yetkilendirmesi + replay koruması, scrypt parola,
  HMAC oturum çerezi, SHA-256 delil zinciri.
- **"Donanımda çalıştı mı?"** → Evet. ESP32 firmware'ini gerçek karta yükledim; HMAC
  imzalı yetkilendirme ve replay koruması gerçek donanımda doğrulandı (imzalı→200,
  imzasız/bozuk→401, replay→401). Portal/RADIUS/loglama katmanı ise Node'da uçtan uca çalışıyor.
- **"Nasıl test ettin?"** → Üç katman: `npm test` ile 150+ birim ve uç nokta testi
  (kum havuzunda, gerçek veriye dokunmadan), `npm run simulate` ile uçtan uca demo,
  `npm run attack` ile saldırı regresyonu. 5651 log satırının biçimi de testle
  kilitli — kazara değişirse test kırılır.
- **"Prod'a hazır mı?"** → Hayır, simülasyon aşamasında ve dürüstçe öyle etiketledim.
  Saha için ağ geçidi MikroTik/pfSense'e, imzalama gerçek KamuSM TSA'ya taşınmalı, portal
  TLS zorunlu olmalı. Mimari bunları standart protokoller sayesinde destekliyor.
