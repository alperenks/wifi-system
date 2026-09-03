# GECE GELİŞTİRME LOOP'U — wifi-system

> Bu dosya, Alperen uyurken/uzaktayken `wifi-system`'i güvenli biçimde geliştiren
> otonom loop'un talimatıdır. Loop `/loop` ile başlatılır ve bu dosyayı okuyup uygular.
> Her uyanış SIFIRDAN başlar; tek hafıza bu dosya + git geçmişi + backlog durumu.

ÇALIŞMA KLASÖRÜ: C:\Users\alper\OneDrive\Masaüstü\wifi-system

---

## 0. DEĞİŞMEZ KURALLAR (her zaman geçerli)

1. **Dal: `gece-gelistirme`.** Her oturumun başında `git checkout gece-gelistirme` yap.
   ASLA `main`'e commit'leme. Alperen sabah inceleyip beğendiğini kendisi merge eder.
2. **Her adımı commit'le.** Bir görevi bitirip DOĞRULADIKTAN sonra hemen commit at
   (küçük, anlamlı commit'ler). Böylece her şey geri alınabilir.
3. **DOĞRULAMADAN commit'leme.** Kod değiştirdiysen aşağıdaki test kapısını geç.
   Testler kırılırsa: `git checkout -- .` ile değişikliği GERİ AL, backlog'a "denendi,
   şu sebeple başarısız" not düş, sonraki göreve geç. Kırık kod commit'lenmez.
4. **ASLA DOKUNMA:**
   - `.env`, `secrets.h`, `backend/db.json`, `logs/` — sırlar ve kişisel veri.
   - Gerçek gönderim / yayın: `git push`, GitHub'a yükleme, dış servise istek.
   - Donanım-bağlı işler: ESP32 birleşik testi, MikroTik/pfSense kurulumu (Alperen + donanım gerekir).
   - `main` dalı.
   - Yeni ücretli/dış bağımlılık ekleme (önce backlog'a öneri olarak yaz, Alperen karar versin).
5. **Bir şeyi "yaptım" demeden önce çalıştır.** Kanıt = test çıktısı. Çalıştıramadıysan
   "yazıldı ama doğrulanmadı" de.
6. **Kararsız/mimari kararda dur.** Emin değilsen backlog'a "Alperen'e soru" olarak yaz,
   kendi kararınla büyük yön değiştirme.

---

## 1. TEST KAPISI ("doğrulandı" ne demek?)

Değiştirdiğin katmana göre:

- **Saf birim mantığı (db.js, auth.js, kamusm-signer.js, config.js):**
  `npm test` (varsa) veya ilgili `node --test` dosyasını çalıştır → hepsi geçmeli.
  `npm run test:esp32` ESP32 protokol mantığı için.
- **Sunucu/uç nokta değişikliği:** arka planda sunucuyu başlat
  (`SIM_MODE=true node server.js &`), sonra:
  - `npm run simulate 4 2` → uçtan uca demo REGRESYONU bozulmamalı
  - `npm run attack` → tüm saldırılar hâlâ ENGELLENDİ olmalı (0 açık)
  - bitince sunucuyu kapat (portu bırak).
- **İmzalama/zincir:** `npm run verify-chain` mantığı korunmalı.

Testlerden herhangi biri düzeltmenden SONRA kırılırsa değişiklik GERİ ALINIR.

---

## 2. HER OTURUMUN AKIŞI

1. `git checkout gece-gelistirme` (yoksa oluştur).
2. Bu dosyanın **Backlog** bölümünü oku. `[ ]` olan, engelli olmayan, en üstteki görevi al.
3. Görevi küçük bir adım olarak uygula (tek dosya/tek konu tercih et).
4. Test kapısını geç. Geçerse commit'le (`Add:`/`Fix:`/`Doc:` + tek satır).
   Kırılırsa geri al, backlog'a not düş.
5. Backlog'da görevi `[x]` (bitti) veya `[~]` (kısmen, not ekle) işaretle.
6. Zaman/kapasite varsa sıradaki göreve geç; yoksa **GÜN SONU ÖZETİ** yaz (aşağı).
7. Bir sonraki uyanışa kadar bekle.

---

## 3. GÜN SONU ÖZETİ (her turun sonunda)

Bu dosyanın en altındaki **## İLERLEME GÜNLÜĞÜ**'ne 2-4 satır ekle:
- Tarih, hangi görev(ler) yapıldı, kaç commit, test sonucu.
- Neyi geri aldın ve neden.
- Alperen'in bakması gereken bir şey (karar, donanım-bağlı iş) varsa **AÇIKÇA** yaz.

---

## 4. BACKLOG (öncelik sırasıyla — üstten al)

> En güvenli ve yüksek değerli işler üstte: test eklemek prod'u bozamaz.

### A. Test altyapısı (en güvenli, önce bunlar)
- `[x]` **A1 — Birim testleri: db.js.** `node --test` ile `backend/test/db.test.js`:
  OTP hash+salt doğru, yanlış kod sayacı artıyor, 5'te kilit, `timingSafeEqual` yolu,
  oturum sırrı üretiliyor, `purgeExpired` eski kayıtları siliyor. Kabul: `node --test` yeşil.
- `[x]` **A2 — Birim testleri: auth.js.** Token üret→doğrula, süresi geçmiş token reddi,
  kurcalanmış imza reddi, scrypt parola doğru/yanlış. Kabul: yeşil.
- `[x]` **A3 — Birim testleri: kamusm-signer.js.** İmzala→zincir doğru, araya gün ekleme/
  silme zinciri kırıyor, içerik değişimi yakalanıyor. Kabul: yeşil.
- `[x]` **A4 — `npm test` scripti** package.json'a: tüm `node --test` dosyalarını koşsun.

### B. Eksik güvenlik özellikleri
- `[x]` **B1 (F-10) — Veri kotası.** Accounting interim-update'te toplam bayt eşiği aşılınca
  RADIUS Disconnect-Message (CoA/DM) gönder; eşik config'ten (`retention`/yeni `quota`).
  Kabul: kotayı düşük ayarla, simulate ile aşır, oturumun kapandığını logla/test et.
- `[x]` **B2 (F-05) — TLS kolaylığı.** `scripts/gen-cert.js` veya README komutu ile
  kendinden imzalı sertifika üret; `TLS_ENABLED=true` ile HTTPS başladığını doğrula.
  Kabul: TLS açıkken `https://localhost:3000/captive` yanıt veriyor (öz-imzalı uyarı normal).

### C. Belgeler / mimari
- `[x]` **C1 (F-11) — pfSense/MikroTik kural seti belgesi.** `docs/AG-GECIDI-KURALLARI.md`:
  misafir VLAN izolasyonu (iç ağa erişim yok), pfBlockerNG DNS filtreleme, DNS zorlaması,
  gereksiz port kapatma, RADIUS+syslog yönlendirme. Örnek MikroTik komutları + pfSense adımları.
  Kabul: bir ağ yöneticisi bunu izleyip sahayı kurabilecek netlikte.
- `[x]` **C2 — README mimari diyagramı.** README'ye mermaid akış diyagramı (misafir→portal→
  OTP→RADIUS→syslog→imza). Kabul: diyagram render oluyor, metinle tutarlı.
- `[x]` **C3 — `restoran_secret` genericleştirme.** Kurulum belgelerinde geçen örnek RADIUS
  sırrını `<RADIUS_SECRET_DEGERINIZ>` gibi yer tutucuya çevir. Kabul: docs'ta gerçek örnek sır yok.

### D. Kalite / sağlamlık
- `[x]` **D1 — `/api/health` uç noktası** (kimlik doğrulamasız, {status, uptime, mode}).
  Kabul: 200 döner, simulate'i bozmaz.
- `[x]` **D2 — Dashboard: kalan OTP deneme + kilit durumu göster.** verify-otp yanıtındaki
  `remaining` bilgisini captive.html'de göster. Kabul: 3 yanlış girince "2 hak kaldı" görünür.
- `[x]` **D3 — Girdi doğrulama sertleştirme.** Tüm uçlarda gövde şeması kontrolü (mac formatı,
  beklenm//eyen alanlar). Kabul: bozuk gövde 400 döner, sunucu çökmez; attack/simulate yeşil.
- `[x]` **D4 — Tutarlı hata yanıtı + merkezi hata middleware'i.** Kabul: fırlatılan hatalar
  500 JSON'a dönüşür, stack sızmaz; regresyon yeşil.

### E. Öneriler (Alperen kararı — loop UYGULAMAZ, sadece araştırıp yazar)
- `[x]` **E1 — Gerçek RFC 3161 (KamuSM TSA) entegrasyon notu.** `.tsq`/`.tsr` akışını araştır,
  `docs/TSA-ENTEGRASYON-PLANI.md` olarak yaz. Kod yazma — plan çıkar.
- `[x]` **E2 — db.json → SQLite göç değerlendirmesi.** Artı/eksi, göç eskizi. Belge olarak.

### F. Sonraki tur adayları (loop'un 1. turda not ettikleri — öncelik Alperen'in)
> Bunlar backlog'daki işler yapılırken ortaya çıkan, gerçek gözleme dayanan maddelerdir.

- `[ ]` **F1 — `db.json` atomik yazma.** `save()` şu an doğrudan üstüne yazıyor; yazma
  sırasında kesinti olursa dosya yarım kalır ve `load()` sessizce BOŞ veritabanına
  döner (delil kaybı). Çözüm: geçici dosyaya yaz + `rename`. Kabul: yarım dosya
  simülasyonunda eski veri korunuyor; `npm test` yeşil.
  Gerekçe: `docs/SQLITE-DEGERLENDIRMESI.md` §2.2.
- `[ ]` **F2 — `save()` biriktirme (debounce).** 11 çağrı noktası var; ardışık yazmaları
  200 ms'de topla, kapanışta flush. Kabul: `npm run simulate 6 3` sırasında yazma
  sayısı belirgin düşüyor, veri kaybı yok.
- `[ ]` **F3 — `/api/health`'e `dbSizeKb` + `activeSessions`.** SQLite geçiş eşiğini
  (5 MB) izleyebilmek için. Kabul: alanlar dönüyor, sır sızmıyor, simulate yeşil.
- `[ ]` **F4 — Kota durumunu panelde göster.** `QUOTA_MB` açıkken oturum satırında
  kullanılan/kalan veri çubuğu. Kabul: kota aşan oturum panelde "kota doldu" görünüyor.
- `[ ]` **F5 — `attack.js`'e kota/CoA senaryosu ekle.** Kotayı aşan misafirin gerçekten
  düşürüldüğünü saldırı testi de kanıtlasın. Kabul: yeni senaryo ENGELLENDI/OK dönüyor.
- `[ ]` **F6 — Yönetici giriş limiti test akışını kilitliyor.** `npm run attack` 5 kez
  yanlış giriş denediği için sonrasında 15 dakika `/api/auth/login` 429 dönüyor; panel
  elle kontrol edilemiyor. Öneri: limiti aşan istekler için `Retry-After` başlığı +
  README'ye not, ya da attack sonrası uyarı satırı. Kabul: davranış belgelenmiş.
- `[ ]` **F7 — (Alperen'e soru) Gerçek TSA kararı.** `docs/TSA-ENTEGRASYON-PLANI.md`
  §7'deki dört karar verilmeden kod yazılmamalı.

---

## İLERLEME GÜNLÜĞÜ

> Loop her turda buraya yazar.

### 2026-09-03 — 1. tur (gece-gelistirme dalı, 15 commit)

**Yapılanlar — backlog'un A/B/C/D/E bölümlerinin TAMAMI bitti:**

| Görev | Sonuç | Kanıt |
|---|---|---|
| A1-A4 | db.js, auth.js, kamusm-signer.js birim testleri + `npm test` | 78 test, hepsi yeşil |
| B1 (F-10) | Veri kotası + gerçek RFC 5176 Disconnect | 6 entegrasyon testi (gerçek UDP) + `QUOTA_MB=2` ile canlı koşu: iki misafir de düşürüldü, `Disconnect-ACK` alındı |
| B2 (F-05) | `npm run gen-cert` (openssl, ek bağımlılık yok) | `TLS_ENABLED=true` ile `https://localhost:3000/captive` → HTTP 200, TLSv1.3 |
| C1 (F-11) | `docs/AG-GECIDI-KURALLARI.md` — pfSense + MikroTik kural seti | belge, doğrulama kontrol listesiyle |
| C2 | README mermaid uçtan uca diyagramı | mermaid 10.9.1 ile tarayıcıda render edildi (RENDER OK) |
| C3 | Belgelerdeki örnek RADIUS sırrı yer tutucuya çevrildi | `.md` dosyalarında gerçek sır kalmadı |
| D1 | `/api/health` | kimlik doğrulamasız HTTP 200 |
| D2 | Portalda kalan OTP hakkı + kilit durumu | tarayıcıda 4-3-2-1 sayımı, 5.'de form kilitlendi (ekran görüntüsü alındı) |
| D3 | `validate.js` — tüm POST uçlarında gövde şeması | 13 test; bozuk MAC/OTP/fazladan alan → 400, sunucu ayakta |
| D4 | `errors.js` — merkezi hata katmanı | 9 test; bozuk JSON artık HTML+stack yerine JSON 400 |
| E1 | `docs/TSA-ENTEGRASYON-PLANI.md` (yalnızca plan) | `.tsq` üretimi yerelde denendi, özet dosyayla eşleşti |
| E2 | `docs/SQLITE-DEGERLENDIRMESI.md` (yalnızca değerlendirme) | ölçüm: ~490 bayt/kayıt, 2 yılda ~43 MB tam-dosya yazımı |

**Her turda koşturulan test kapısı:** `npm test` (78/78) · `npm run simulate` (tüm
misafirler oturum açtı) · `npm run attack` (5 engellendi, 0 açık) · panelde oturumlar
ve telefon numarası çözülmüş 5651 log satırları · `npm run verify-chain` (zincir geçerli).

**Geri alınan bir şey yok** — kırık testle commit atılmadı.

**Tek davranış değişikliği riski:** `verify-chain.js` artık `verifyChain(logsDir)`
fonksiyonunu dışa aktarıyor ve CLI'yi `require.main` altında koşuyor. Doğrulama
kuralları ve çıktı birebir aynı; komut öncesi/sonrası çıktı karşılaştırıldı.

**Alperen'in bakması gerekenler:**
1. **F7 / TSA kararı** — gerçek zaman damgası için KamuSM sözleşmesi ve 4 karar
   (`docs/TSA-ENTEGRASYON-PLANI.md` §7). Sahaya çıkmadan ÖNCE kapanmalı.
2. **SQLite** — şimdi gerekmiyor; ama F1 (atomik yazma) delil kaybı riskini
   kapattığı için ucuz ve değerli (`docs/SQLITE-DEGERLENDIRMESI.md` §7).
3. **Kota varsayılanı kapalı** (`QUOTA_MB=0`). Restoranda misafir başına sınır
   istiyor musunuz? İstiyorsanız `.env` değerini siz belirlemelisiniz.
4. **pfSense'te CoA/3799 desteği** donanım/kurulum gerektiren tek doğrulama —
   `docs/AG-GECIDI-KURALLARI.md` §6.5'teki testi sahada yapmak gerekiyor.
5. Dal `gece-gelistirme`, 15 commit, `main`'e dokunulmadı, push yapılmadı.
