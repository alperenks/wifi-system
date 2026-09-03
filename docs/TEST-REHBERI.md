# wifi-system — Baştan Sona Test Rehberi

> SIM_MODE=true (varsayılan) ile, donanımsız, tek bilgisayarda tüm sistemi test etme.

## Yönetici girişi
- Kullanıcı: **admin**
- Parola: **admin123**
- (SIM modunda varsayılan; sunucu açılışta konsola da yazar. Üretimde `.env`'den gelir.)

---

## 1. Sunucuyu başlat

```
cd backend
npm start
```

Açılışta şu satırları görmelisin: portal adresi, yönetici girişi ve SIM demo parolası,
ardından `[RADIUS] ... listening`, `[SYSLOG] ... listening`. Sunucu bu terminalde açık kalır.

## 2. Yönetici paneline gir

Tarayıcı → **http://localhost:3000/login** → admin / admin123 → panele yönlenir.
(Doğrudan /dashboard'a gidersen otomatik /login'e düşer — bu F-12 düzeltmesi, normal.)

## 3. Misafir akışını ELLE dene (asıl uçtan uca test)

Yeni bir sekme → **http://localhost:3000/captive**

1. Telefon numarası gir: **5XXXXXXXXX** (başında 0 yok, örn. 5551234567)
2. "Kod gönder" → SIM modunda gerçek SMS gitmez; **OTP ekranda görünür** (ayrıca sunucu
   konsolunda `[SMS OUTBOX]` bloğunda da yazar).
3. Kodu gir → "İnternet erişiminiz açıldı" mesajı.

Panele (sekme 2) dön ve yenile: **aktif oturum** belirir, **5651 logu** dolmaya başlar.

### Test edilecek güvenlik davranışları (elle)
- **Yanlış kod:** 5 kez yanlış gir → 5.'de "çok fazla hatalı deneme, yeni kod iste" (kilit).
- **Hız limiti:** aynı numaraya üst üste hızlı kod istersen "dakikada en fazla 1" uyarısı (429).

## 4. Hızlı yol: otomatik misafir kalabalığı

Elle uğraşmadan paneli doldurmak için **ikinci bir terminalde**:

```
cd backend
npm run simulate 6 3      # 6 sanal misafir, her biri 3 tur gezinsin
```

Panelde 6 oturum + gezinme trafiği + büyüyen 5651 logu görürsün. (Bu betik önce
admin olarak login olur, çünkü sim uçları da korumalı.)

## 5. Delil zincirini test et

Panelde **"Bugünün Günlüğünü Mühürle"** butonu → o günün logu gzip'lenir, SHA-256 alınır,
zincire bağlı `.ts` damgası üretilir. Sonra terminalde:

```
npm run verify-chain      # zinciri doğrular: kopukluk/kurcalama var mı?
```

İstersen bir `.log.gz`'yi bozup tekrar çalıştır → "içerik değiştirilmiş" demeli.

## 6. Güvenlik testleri (opsiyonel)

Sunucu çalışırken, ayrı terminalde:

```
npm run attack            # OTP brute force, SMS bomba, log silme, geçmiş sızıntısı → hepsi ENGELLENDİ
npm run test:esp32        # ESP32 yetkilendirme protokolü (imza/replay/stale)
```

## 7. Gerçek ESP32 (donanım) testi — ayrı

1. ESP32 USB'de takılı ve firmware yüklü (BENCH_TEST=1).
2. Laptopu **"Restoran_Misafir_Wifi"** ağına bağla (internet gider, normal).
3. `esp32-hw-test.bat`'a çift tıkla → sonuç `docs/esp32-hw-test-sonuc.txt`.
4. WiFi'ı normal ağına geri bağla.

---

## Temiz başlangıç (isteğe bağlı)
Demo verisini sıfırlamak için panelde **"Sıfırla"** (yalnızca SIM modunda) ya da elle:
`db.json` içeriğini `{"guestFlows":[],"radcheck":{},"radreply":{},"radacct":[],"leases":{}}`
yap ve `logs/5651_captive/` içindeki dosyaları sil.

## Sık takılınan
- **Panel açılmıyor / login'e atıyor:** normal — admin/admin123 ile gir.
- **"dakikada 1 SMS" uyarısı:** hız limiti çalışıyor, ~1 dk bekle veya farklı numara.
- **OTP nerede:** SIM modunda ekranda + sunucu konsolunda (`[SMS OUTBOX]`).
