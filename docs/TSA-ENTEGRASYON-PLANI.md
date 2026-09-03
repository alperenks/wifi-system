# GERÇEK ZAMAN DAMGASI (RFC 3161 / KamuSM) — ENTEGRASYON PLANI

> **Bu belge kod değil, PLANDIR.** Gece loop'u E1 görevi gereği araştırıp yazdı;
> uygulama kararı ve KamuSM sözleşmesi Alperen'e aittir.
>
> **Doğrulanması gereken noktalar `⚠ DOĞRULA` ile işaretlendi** — bunlar KamuSM'nin
> kendi müşteri dokümanından/servis sözleşmesinden teyit edilmeden koda geçmemeli.

---

## 1. Bugün ne var, ne yok?

`backend/kamusm-signer.js` her gece 23:59'da şunu yapıyor:

| Adım | Durum |
|---|---|
| Günlük `.log` → `.log.gz` sıkıştırma | ✅ gerçek |
| `.log.gz` dosyasının SHA-256 özeti | ✅ gerçek |
| `previousHash` ile günleri birbirine bağlama (delil zinciri) | ✅ gerçek |
| Damga dosyası `.ts` üretimi | ⚠️ **sahte** — `config.kamusm.mockKey` ile HMAC |
| Damganın **üçüncü tarafça** doğrulanabilirliği | ❌ yok |

Yani sistem bugün **"ben bu dosyayı bu içerikle mühürledim"** diyebiliyor ama
**"bunu şu tarihte mühürledim, güvenilir bir üçüncü taraf da şahit"** diyemiyor.
5651 kapsamında bir uyuşmazlıkta kanıt değeri olan şey ikincisidir.

**Değişmeyecek olan:** zincir yapısı (`previousHash`) gerçektir ve kalır. Gerçek TSA
entegrasyonu bunun **yerine** değil, **yanına** gelir: zincir "bir gün silinmiş mi?"
sorusunu, TSA "bu tarihte gerçekten var mıydı?" sorusunu yanıtlar.

---

## 2. RFC 3161 akışı (protokolün özü)

```
  bizim taraf                                 TSA (KamuSM)
  -----------                                 ------------
  1. .log.gz dosyasının SHA-256 özeti
  2. TimeStampReq (.tsq) üret
     { hashAlgorithm: sha256,
       hashedMessage: <32 bayt özet>,
       nonce: <rastgele>,
       certReq: true }
                    ──── HTTP POST ────►
                    Content-Type:
                    application/timestamp-query
                                                3. Özeti KENDİ saatiyle imzalar
                                                   (TSA'nın kendi sertifikasıyla)
                    ◄─── HTTP 200 ─────
                    Content-Type:
                    application/timestamp-reply
  4. TimeStampResp (.tsr) sakla
     içinde TimeStampToken (CMS SignedData):
       - genTime (damga zamanı)
       - hashedMessage (bizim özet)
       - TSA imzası + sertifika zinciri
  5. Doğrulama: .tsr + .log.gz + TSA kök sertifikası
```

**Kritik nokta:** TSA dosyayı görmez, yalnızca **özetini** görür. Misafirlerin
telefon numaraları KamuSM'ye gitmez — KVKK açısından bu önemlidir ve müşteriye
de böyle anlatılmalıdır.

---

## 3. Elle deneme (kod yazmadan önce bunu yapın)

`openssl` bu depoda zaten kullanılıyor (`npm run gen-cert`), ek kurulum gerekmez.

```bash
cd backend/logs/5651_captive

# 1) Zaman damgası isteği (.tsq) üret — dosyanın kendisi değil, özeti gider
openssl ts -query -data 2026-09-03.log.gz -sha256 -cert -no_nonce -out 2026-09-03.tsq

# İstek gerçekten doğru mu? (okunabilir hâli)
openssl ts -query -in 2026-09-03.tsq -text

# 2) TSA'ya gönder   ⚠ DOĞRULA: gerçek uç nokta ve kimlik doğrulama yöntemi
curl -s -H "Content-Type: application/timestamp-query" \
     --data-binary @2026-09-03.tsq \
     -u "<MUSTERI_NO>:<MUSTERI_PAROLA>" \
     "<KAMUSM_TSA_URL>" -o 2026-09-03.tsr

# 3) Yanıtı oku (granted mı, rejection mı?)
openssl ts -reply -in 2026-09-03.tsr -text

# 4) Doğrula — bu komut sahada "delil geçerli mi?" sorusunun cevabıdır
openssl ts -verify -data 2026-09-03.log.gz -in 2026-09-03.tsr \
     -CAfile kamusm-kok-zincir.pem
```

Adım 4 `Verification: OK` derse entegrasyon teknik olarak bitmiş demektir; geri kalan
iş bu akışı Node'a taşımaktır.

> **Adım 1 bu depoda denendi (2026-09-03).** `2026-09-01.log.gz` için üretilen `.tsq`
> içindeki `Message data` alanı, dosyanın gerçek SHA-256 özetiyle birebir aynı çıktı
> (`278a3540…b5c1`). Yani istek üretimi bugünkü openssl ile sorunsuz çalışıyor;
> 2-4. adımlar gerçek TSA hesabı gerektirdiği için denenmedi.

### ⚠ DOĞRULA listesi (KamuSM dokümanından teyit edilecek)

1. **Uç nokta adresi.** Depoda `KAMUSM_TSA_URL` varsayılanı `http://zd.kamusm.gov.tr`.
   Gerçek servis adresi, HTTPS zorunluluğu ve port müşteri dokümanından alınmalı.
2. **Kimlik doğrulama.** HTTP Basic mi, istemci sertifikası mı, yoksa istek gövdesine
   gömülü müşteri numarası mı? (Kurumsal TSA'larda üçü de görülür.)
3. **Kontör/ücretlendirme.** Damga başına ücret, minimum paket, kontör bitince
   servisin verdiği hata kodu.
4. **Politika OID'i.** Kodda şu an yer tutucu var: `1.2.840.113549.1.9.16.1.4`.
   Gerçek TSA kendi politika OID'ini döner; `.tsq` içinde talep edilecek mi?
5. **Kök sertifika zinciri.** Doğrulama için gereken CA zinciri nereden indirilir?
   **Bu zincir arşivle birlikte saklanmalıdır** (bkz. §6, Risk 3).
6. **Hash algoritması.** SHA-256 kabul ediliyor mu, SHA-1 dayatması var mı?

---

## 4. Koda taşıma — iki seçenek (Alperen kararı)

### Seçenek A — `openssl` alt süreci (ek npm bağımlılığı YOK) ⭐ önerilen

`kamusm-signer.js` içinde `child_process.spawnSync('openssl', ['ts', '-query', ...])`
ile `.tsq` üretilir, `axios` (zaten bağımlılık) ile POST edilir, dönen `.tsr` diske yazılır.
Doğrulama da `openssl ts -verify` ile yapılır.

- ➕ Yeni bağımlılık yok; ASN.1 kodlamasını kendimiz yazmayız (hata riski en aza iner).
- ➕ `gen-cert` zaten openssl'e bağlı — sistem gereksinimi değişmez.
- ➖ Sunucuda openssl bulunmak zorunda (pfSense'te ve Windows'ta Git ile birlikte var).
- ➖ Alt süreç yönetimi ve hata ayıklama biraz daha zahmetli.

### Seçenek B — Saf JS ASN.1 kütüphanesi

`node-forge` veya `@peculiar/asn1-tsp` ile `.tsq` üretip `.tsr` ayrıştırılır.

- ➕ Tek çalışma zamanı, alt süreç yok.
- ➖ **Yeni bağımlılık** — CLAUDE.md gereği bu karar Alperen'e ait.
- ➖ CMS/SignedData doğrulaması JS tarafında ciddi iş; yanlış yapılırsa
  "doğruladım" diyen ama aslında doğrulamayan bir kod ortaya çıkar (en kötü sonuç).

**Öneri:** A ile başlanmalı. B'ye ancak sahada openssl sorun çıkarırsa geçilmeli.

---

## 5. Dosya düzeni ve geçiş planı

### Yeni dosya düzeni (mevcut düzenin üstüne eklenir, hiçbir şey silinmez)

```
logs/5651_captive/
  2026-09-03.log        # ham 5651 kaydı        (değişmiyor)
  2026-09-03.log.gz     # sıkıştırılmış         (değişmiyor)
  2026-09-03.ts         # zincir + damga üstverisi (JSON, korunuyor)
  2026-09-03.tsr        # YENİ: gerçek RFC 3161 yanıtı (ikili)
  chain.json            # zincir indeksi        (değişmiyor)
  ca/kamusm-zincir.pem  # YENİ: doğrulama için TSA kök zinciri
```

`.ts` dosyası **kalır**: içindeki `previousHash`/`chainHash` alanları zinciri taşır.
Yalnızca `mock: true` alanı `false` olur ve `tsrFile: "2026-09-03.tsr"` eklenir.
Böylece **log satır biçimi ve zincir algoritması hiç değişmez** — CLAUDE.md'nin
"imza zincirini değiştirme" kuralı korunur.

### Geçiş adımları

1. `.env`'e alanlar: `KAMUSM_TSA_URL`, `KAMUSM_TSA_USER`, `KAMUSM_TSA_PASS`,
   `KAMUSM_CA_PATH`, `TSA_ENABLED=false` (varsayılan kapalı — mevcut demo bozulmaz).
2. `signDailyLog()` içinde imza adımı ikiye ayrılır:
   `TSA_ENABLED=true` ise gerçek damga, değilse bugünkü mock. **Zincir her iki
   durumda da aynı hesaplanır.**
3. `verify-chain.js` genişletilir: `.tsr` varsa `openssl ts -verify` de koşturulur,
   sonuç satıra eklenir (`[OK] 2026-09-03 chainHash=... TSA doğrulandı`).
4. Test: geçici bir test dizininde sahte bir "TSA" HTTP sunucusu (kayıtlı bir `.tsr`
   döndüren) ile `test/tsa.test.js` yazılır — ağ olmadan koşabilmeli.
5. Sahada ilk gün elle doğrulama: §3 adım 4 komutu çalıştırılıp çıktısı
   `docs/` altına kanıt olarak kaydedilir.

### TSA'ya ulaşılamazsa ne olacak? (bu maddeyi atlamayın)

- Damga alınamayan gün için `.ts` dosyası yine yazılır, `tsaStatus: "pending"` işaretlenir.
- Bir yeniden deneme kuyruğu (`pending.json`) tutulur; sonraki çalışmada tekrar denenir.
- **Zincir asla beklemez** — `chainHash` o gün de hesaplanır; aksi hâlde zincirde delik
  oluşur ve sonraki günlerin tamamı geçersizleşir.
- Üst üste 3 gün başarısızlık → panelde görünür uyarı (bu, müşterinin fark etmesi
  gereken bir olaydır; sessizce geçilmemeli).

---

## 6. Riskler

| # | Risk | Etkisi | Önlem |
|---|---|---|---|
| 1 | **Kontör bitmesi** | O günün damgası alınamaz | Kalan kontör panelde gösterilsin, eşiğin altında uyarı |
| 2 | **TSA erişilemez** (ağ/servis kesintisi) | Damga gecikir | Yeniden deneme kuyruğu (§5), zincir devam eder |
| 3 | **CA zinciri sonradan bulunamaz** | 2 yıl sonra delil doğrulanamaz | Kök zinciri **arşivin içine** kopyala (`ca/`), yedeklere dâhil et |
| 4 | **Sunucu saati kayması** | `.ts` üstverisindeki yerel zaman TSA `genTime`'ından sapar | Yalnızca TSA'nın `genTime`'ı esas alınsın; yerel zaman bilgi amaçlı |
| 5 | **TSA sertifikasının süresi dolması** | Eski damgalar şüpheye düşer | Uzun vadede damganın üstüne yeniden damga (RFC 4998 arşiv damgası) — ilk sürümde kapsam dışı, not düşüldü |
| 6 | **openssl sürüm farkı** (Seçenek A) | Komut çıktısı değişir | Sürüm kontrolü + `-text` çıktısına değil, dönüş koduna bakılsın |

---

## 7. Alperen'in karar vermesi gerekenler

1. **KamuSM sözleşmesi/kontörü alınacak mı?** Ücretli servis; müşteriye maliyet kalemi
   olarak yansıyacak. Alternatif: ücretsiz/kurumsal başka bir RFC 3161 TSA
   (ör. FreeTSA — hukuki değeri Türkiye'de tartışmalı, yalnızca teknik demo için).
2. **Seçenek A mı B mi?** (§4 — öneri: A)
3. **Ne zaman?** Sahaya çıkış Ağustos 2026; TSA entegrasyonu **canlıya geçmeden önce**
   tamamlanmalı, çünkü ilk günün logu da hukuken damgalı olmalıdır.
4. **Kim doğrulayacak?** Yıllık bir "delil tatbikatı" (rastgele bir günün `.tsr`'ını
   doğrulama) süreç olarak müşteriye önerilecek mi?

---

## 8. İlgili dosyalar

- `backend/kamusm-signer.js` — bugünkü mock damga + gerçek zincir
- `backend/verify-chain.js` — zincir doğrulayıcı (`verifyChain(logsDir)` olarak dışa aktarılmış)
- `backend/test/kamusm-signer.test.js` — zincirin bozulma senaryoları
- `docs/GUVENLIK-DEGERLENDIRMESI.md` — F-08 bulgusu ve neden zincir eklendiği
