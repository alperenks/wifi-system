# Wireshark ile Paket Doğrulama Rehberi

Müşteriye "sistem gerçekten konuşuyor" demenin en ikna edici yolu, paketleri canlı göstermektir. Bu rehber, simülasyon çalışırken hangi trafiği nerede yakalayacağınızı ve hangi filtreleri kullanacağınızı anlatır.

## Nereyi dinlemeli?

- **Saf yazılım (Seviye 0)**: Tüm trafik `127.0.0.1` (loopback) üzerindedir.
  - Windows'ta **Npcap**'i "loopback desteği ile" kurun, Wireshark'ta **Adapter for loopback traffic (npcap loopback)** arayüzünü seçin.
- **ESP32 / pfSense (Seviye 1-2)**: PC'nin Wi-Fi/Ethernet arayüzünü seçin.

## Hazırlık

1. `node server.js` çalıştırın.
2. Wireshark'ı loopback arayüzünde başlatın.
3. Ayrı terminalde `npm run simulate 3 2` çalıştırın.

## İşe yarayan görüntüleme filtreleri (display filter)

| Ne görürsünüz | Filtre |
|---|---|
| RADIUS kimlik doğrulama + hesap (Access/Accounting) | `radius` |
| Sadece Access-Request/Accept (1812) | `udp.port == 1812` |
| Sadece Accounting Start/Stop (1813) | `udp.port == 1813` |
| Syslog akışı (pfSense/MikroTik → toplayıcı) | `udp.port == 514` |
| DNS sorguları (kullanıcı hangi siteye gitti) | `dns` |
| Belirli bir misafir IP'si | `ip.addr == 192.168.20.100` |

## Ne göreceksiniz (ve müşteriye ne anlatacaksınız)

1. **`radius` filtresi**: Her misafir bağlandığında bir **Access-Request → Access-Accept** çifti. Accept paketinin içinde `Session-Timeout = 7200` görünür → "kullanıcıyı 2 saat sonra tekrar doğrulatıyoruz".
2. **`udp.port == 1813`**: **Accounting-Request (Start)** paketi `Acct-Session-Id`, `Framed-IP-Address` ve `User-Name` (MAC) taşır → "bağlantının başladığı saniye ve kime ait olduğu mühürleniyor". Ayrılışta **Stop** paketi `Acct-Input/Output-Octets` (harcanan trafik) taşır.
3. **`udp.port == 514`**: pfSense'in `filterlog` (hedef IP/port) ve `unbound` (DNS) satırları → "hangi cihaz, nereye bağlandı" ham hali.
4. Bu ham Syslog satırlarının, `backend/logs/5651_captive/<tarih>.log` içinde **telefon numarasıyla eşleşmiş** okunabilir 5651 kaydına dönüştüğünü panelde gösterin.

## RADIUS paketini "deşifre" ettirmek (opsiyonel)

RADIUS'un User-Password/Authenticator alanlarını Wireshark'ta doğrulatmak isterseniz shared secret'ı girin:
**Edit → Preferences → Protocols → RADIUS → Shared secret** = `restoran_secret` (veya `.env` içindeki `RADIUS_SECRET`).

## Kanıt paketi (pcap) kaydetme

Sunum için: Wireshark'ta **File → Save As** ile `.pcapng` kaydedin. Bu dosya, "sistem bu paketleri üretti" iddianızın somut kanıtı olur. Adli senaryoda da aynı yöntem geçerlidir.
