# `db.json` → SQLite GEÇİŞ DEĞERLENDİRMESİ

> **Bu belge kod değil, DEĞERLENDİRMEDİR.** Gece loop'u E2 görevi gereği yazdı.
> Karar (geçilecek mi, ne zaman) Alperen'e aittir. Yeni bağımlılık önerisi içerir —
> CLAUDE.md gereği bu tek başına uygulanamaz.

---

## 1. Bugünkü durum — ölçülmüş sayılarla

`backend/db.js` tek bir JSON dosyasını tutuyor: `load()` başlangıçta tamamını okuyor,
`save()` **tamamını yeniden yazıyor**. Kodda 11 ayrı `this.save()` çağrısı var; yani
her OTP akışı, her IP kirası, her accounting paketi tüm veritabanını diske basıyor.

Bu depodaki ölçüm (2026-09-03, demo verisiyle):

| Ölçüm | Değer |
|---|---|
| `db.json` boyutu | ~31 KB |
| İçindeki kayıt | 37 akış + 26 oturum + 36 kira |
| Kayıt başına | ~490 bayt |
| Bir günlük 5651 log dosyası (demo trafiği) | ~40 KB |

### Gerçek restoranda ne olur?

Kaba bir tahmin: günde 60 misafir, misafir başına 1 akış + 1 oturum + ara güncellemeler.

| Süre | Kayıt | `db.json` tahmini boyutu | Her yazmada diske basılan |
|---|---|---|---|
| 1 gün | ~120 | ~60 KB | 60 KB |
| 1 ay | ~3.600 | ~1,8 MB | 1,8 MB |
| 6 ay | ~21.600 | ~10 MB | **10 MB** |
| 2 yıl (5651 saklama) | ~87.000 | **~43 MB** | **43 MB** |

Son sütun asıl sorundur: **tek bir misafirin OTP'yi doğrulaması, 43 MB'lık dosyanın
baştan yazılması demektir.** Üstelik proje OneDrive altında duruyor; her yazma bir
senkronizasyon tetikler.

> Not: `purgeExpired()` (F-07) doğrulanmamış akışları ve saklama süresini aşan
> oturumları siliyor — ama saklama süresi **730 gün** olduğu için tabloyu 2 yıl
> boyunca küçültmüyor. Tahmin bu yüzden üst sınır değil, gerçekçi beklenti.

---

## 2. JSON'un bugün gerçekten kırıldığı yerler

1. **Tam dosya yazımı (O(n) her işlemde).** Yukarıdaki tablo. Asıl darboğaz budur.
2. **Atomik olmayan yazma.** `fs.writeFileSync` yazarken elektrik giderse dosya yarım
   kalır ve `load()` JSON parse hatası verir → `catch` bloğu **bellekteki boş
   varsayılanlara döner**, yani o ana kadarki tüm oturum kayıtları sessizce kaybolur.
   5651 kapsamında bu, delil kaybı anlamına gelir. *(Bu, SQLite'tan bağımsız olarak
   bugün de düzeltilebilir: geçici dosyaya yaz + `rename` ile yer değiştir.)*
3. **Eşzamanlılık.** Node tek iş parçacıklı olduğu için şu an güvenli; ancak ikinci
   bir süreç (ör. bakım betiği) aynı dosyaya yazarsa kayıp kaçınılmaz.
4. **Sorgulama.** Adli arama (`/api/dashboard/search`) log **dosyalarını** tarıyor;
   oturum sorguları ise dizide `find`/`filter` ile dönüyor. 87 bin kayıtta bu,
   her istekte tam tarama demek.
5. **Yedekten kısmi geri dönüş yok.** Tek dosya; bir günün kaydını geri almak için
   tüm veritabanını geri yüklemek gerekir.

**Bugün kırılmayan şeyler:** okuma hızı (her şey bellekte), basitlik, sıfır bağımlılık,
demo taşınabilirliği (`db.json`'u kopyala, demo taşındı), hata ayıklama kolaylığı
(dosyayı açıp gözle okuyabiliyorsunuz — öğrenme ortamı için gerçek bir değer).

---

## 3. Seçenekler

### Seçenek 0 — Bir şey yapma, JSON kal (bugünkü)
- ➕ Sıfır iş, sıfır risk, demo dosyası taşınabilir.
- ➖ 6 aydan sonra saha kurulumunda yazma maliyeti hissedilir hâle gelir.
- **Uygun olduğu yer:** simülasyon/demo. Sahada 1-2 aylık pilot için de yeterli.

### Seçenek 0.5 — JSON kal, ama iki ucuz düzeltme ⭐ önce bu
1. **Atomik yazma:** `db.json.tmp`'ye yaz, `fs.renameSync` ile yerine koy.
   (Yarım dosya riski biter — §2.2'deki delil kaybı kapanır.)
2. **Yazma biriktirme (debounce):** ardışık `save()` çağrılarını 200 ms'de bir
   toplayıp tek yazmaya indir; kapanışta `flush`.
- ➕ Yeni bağımlılık yok, ~30 satır, en büyük iki riski kapatır.
- ➖ Boyut sorununu ertelemekten ibarettir, çözmez.

### Seçenek 1 — `node:sqlite` (Node 22+ yerleşik) ⭐ geçilecekse bu
Node 22'den beri **çekirdekte** `node:sqlite` modülü var; bu makinede Node 24 kurulu.
- ➕ **npm bağımlılığı YOK** — CLAUDE.md'nin "önce standart kütüphane" kuralına uyar.
- ➕ Satır bazlı yazma: 43 MB değil, tek satır yazılır.
- ➕ Gerçek indeks: `radacct(username)`, `radacct(ip, active)`, `guestFlows(mac)`.
- ➕ WAL kipiyle dayanıklılık ve eşzamanlı okuma.
- ➖ API'si sürüme göre "stable/experimental" durumu değişiyor — **⚠ kullanılacak Node
  sürümünde durumu teyit edilmeli.**
  *(Bu makinede denendi, 2026-09-03: Node 24.18.0 üzerinde `require('node:sqlite')`
  çalışıyor ve `DatabaseSync`, `StatementSync`, `Session`, `backup` API'lerini veriyor.)*
- ➖ Saha sunucusunda Node 22+ zorunlu hâle gelir.

### Seçenek 2 — `better-sqlite3` (npm)
- ➕ Olgun, senkron API (mevcut `db.js` yapısına birebir oturur), hızlı.
- ➖ **Native derleme** gerektirir (node-gyp / prebuild). Windows'ta ve pfSense/FreeBSD
  tarafında kurulum sorunları çıkarabilir — sahaya çıkarken en istemeyeceğiniz sürpriz.
- ➖ Yeni bağımlılık.

**Öneri:** Seçenek 0.5'i hemen yap; SQLite'a geçilecekse **Seçenek 1** (`node:sqlite`).

---

## 4. Şema eskizi (geçilirse)

Mevcut `db.js` veri modeli neredeyse doğrudan tabloya çevrilebiliyor — RADIUS
adlandırması zaten standart:

```sql
CREATE TABLE guest_flows (
  id            TEXT PRIMARY KEY,
  mac           TEXT NOT NULL,
  phone         TEXT NOT NULL,
  salt          TEXT NOT NULL,
  otp_hash      TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  locked_at     INTEGER,
  verified      INTEGER NOT NULL DEFAULT 0,
  verified_at   INTEGER,
  session_secret TEXT
);
CREATE INDEX ix_flows_mac ON guest_flows(mac, verified);

CREATE TABLE radcheck (username TEXT PRIMARY KEY, password TEXT NOT NULL);
CREATE TABLE radreply (username TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL,
                       PRIMARY KEY (username, attribute));

CREATE TABLE radacct (
  session_id    TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  ip            TEXT,
  start_time    INTEGER NOT NULL,
  end_time      INTEGER,
  input_octets  INTEGER NOT NULL DEFAULT 0,
  output_octets INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_acct_user   ON radacct(username, active);
CREATE INDEX ix_acct_ip     ON radacct(ip, active);      -- getPhoneByIp'in sıcak yolu
CREATE INDEX ix_acct_purge  ON radacct(active, end_time); -- purgeExpired

CREATE TABLE leases (mac TEXT PRIMARY KEY, ip TEXT NOT NULL UNIQUE);
```

`radreply` bugünkü JSON'da nesne (`{'Mikrotik-Rate-Limit': '5M/2M', ...}`);
SQL tarafında satır başına bir öznitelik olur — gerçek FreeRADIUS şeması da böyledir,
yani `pfsense-files/radius.sql` ile **daha da yakınsarız**.

---

## 5. Geçiş planı (yapılırsa)

1. `db.js`'in **arayüzü aynı kalır** — `createGuestFlow`, `verifyGuestFlow`,
   `startSession`… Çağıran hiçbir dosya (server.js, radius-server.js) değişmez.
   Yalnızca gövde SQL'e döner. *Bu, geçişi güvenli kılan tek en önemli karar.*
2. `test/db.test.js` **olduğu gibi** koşmalı — 18 test geçiyorsa davranış korunmuştur.
   (Kum havuzu `_sandbox.js` dosya yolunu yönlendiriyor; SQLite için bellek içi
   `:memory:` veritabanına geçilir.)
3. Tek seferlik göç betiği: `scripts/migrate-json-to-sqlite.js` — `db.json` okur,
   tabloları doldurur, sayıları karşılaştırıp rapor eder. `db.json` **silinmez**,
   `db.json.yedek` olarak durur.
4. Bir hafta çift yazma yok — gereksiz karmaşıklık; bunun yerine geri dönüş planı:
   sorun çıkarsa `db.json.yedek` geri konur ve eski sürüm çalıştırılır.
5. 5651 log dosyaları ve imza zinciri **bu işin dışında** — onlar dosya sisteminde
   kalır. Veritabanı yalnızca oturum/kimlik verisidir.

---

## 6. Ne zaman geçilmeli? (tetikleyiciler)

Şimdi değil. Şu üçünden **biri** olduğunda:

- `db.json` **5 MB**'ı geçtiğinde (yaklaşık 3 aylık saha kullanımı), veya
- Panelde oturum listesi/arama gözle görülür yavaşladığında, veya
- İkinci bir süreç (bakım betiği, rapor aracı) aynı veriye yazma ihtiyacı duyduğunda.

Bunu ölçmek kolay: `/api/health` yanıtına `dbSizeKb` eklenebilir, panel eşiği aşınca
uyarır. (Küçük bir iş; ayrı bir görev olarak backlog'a yazılabilir.)

---

## 7. Alperen'in karar vermesi gerekenler

1. Seçenek 0.5 (atomik yazma + debounce) **şimdi** yapılsın mı? — Öneri: **evet**,
   ucuz ve delil kaybı riskini kapatıyor.
2. SQLite'a geçilecekse `node:sqlite` (bağımlılıksız, Node 22+ şartı) mı,
   `better-sqlite3` (olgun ama native derleme) mi?
3. Saha sunucusunda Node sürümü kaç olacak? (`node:sqlite` kararını bu belirler.)
4. `db.json`'un "gözle okunabilir demo dosyası" olma özelliği sizin için ne kadar
   değerli? SQLite'a geçince bu kaybolur (öğrenme ortamı açısından gerçek bir kayıp).

---

## 8. İlgili dosyalar

- `backend/db.js` — bugünkü JSON veritabanı (11 `save()` çağrısı)
- `backend/test/db.test.js` — geçişten sonra da geçmesi gereken 18 test
- `pfsense-files/radius.sql` — sahadaki FreeRADIUS şeması (adlandırma referansı)
- `docs/TSA-ENTEGRASYON-PLANI.md` — aynı formatta yazılmış diğer plan belgesi
