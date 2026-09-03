/*
  =============================================================================
  esp32-hw-test.js — Gerçek ESP32 Donanımı Üzerinde /authorize Testi (F-03)
  =============================================================================
  Laptop ESP32'nin WiFi ağına ("Restoran_Misafir_Wifi") bağlıyken çalıştır.
  ESP32'nin HMAC imzalı yetkilendirme endpoint'ini gerçek donanımda sınar:

    - Geçerli imzalı istek  -> 200 (authorized)
    - İmzasız istek         -> 401 (bad_signature)
    - Bozuk imza            -> 401 (bad_signature)
    - Replay (aynı nonce)   -> 401 (replay)

  Paylaşılan sır .env'deki ESP32_SHARED_SECRET'ten okunur (secrets.h ile aynı olmalı).

  Kullanım:
    node esp32-hw-test.js                 # varsayılan http://192.168.4.1
    node esp32-hw-test.js 192.168.4.1     # IP elle
*/

const crypto = require('crypto');
require('dotenv').config();

const HOST = process.argv[2] || '192.168.4.1';
const BASE = `http://${HOST}`;
const SECRET = process.env.ESP32_SHARED_SECRET;

if (!SECRET) {
  console.error('HATA: .env icinde ESP32_SHARED_SECRET yok. secrets.h ile ayni olmali.');
  process.exit(2);
}

function sign(mac, ts, nonce) {
  const body = JSON.stringify({ mac, ts, nonce });
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return { body, sig };
}

async function send(label, body, sig, expectStatus) {
  try {
    const res = await fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Signature': sig } : {}) },
      body,
    });
    const txt = await res.text().catch(() => '');
    const ok = res.status === expectStatus;
    console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}: HTTP ${res.status} (beklenen ${expectStatus}) ${txt.trim()}`);
    return ok ? 0 : 1;
  } catch (e) {
    console.log(`  [FAIL] ${label}: ESP32'ye ulasilamadi — ${e.message}`);
    console.log(`         (Laptop "Restoran_Misafir_Wifi" agina bagli mi? IP dogru mu: ${HOST})`);
    return 1;
  }
}

async function main() {
  console.log(`\n  ESP32 DONANIM TESTI -> ${BASE}/authorize\n`);
  let fails = 0;
  const now = Math.floor(Date.now() / 1000);
  const mac = 'aabbccddeeff';

  // 1) Geçerli imzalı istek -> 200
  const r1 = sign(mac, now, crypto.randomBytes(8).toString('hex'));
  fails += await send('Gecerli imzali istek', r1.body, r1.sig, 200);

  // 2) İmzasız istek -> 401
  const r2 = sign(mac, now + 1, crypto.randomBytes(8).toString('hex'));
  fails += await send('Imzasiz istek       ', r2.body, null, 401);

  // 3) Bozuk imza -> 401
  const r3 = sign(mac, now + 2, crypto.randomBytes(8).toString('hex'));
  fails += await send('Bozuk imza          ', r3.body, 'deadbeef'.repeat(8), 401);

  // 4) Replay: geçerli bir isteği gönder, sonra AYNISINI tekrar -> ikincisi 401
  const nonce = crypto.randomBytes(8).toString('hex');
  const r4 = sign(mac, now + 3, nonce);
  fails += await send('Replay 1. gonderim  ', r4.body, r4.sig, 200);
  fails += await send('Replay 2. gonderim  ', r4.body, r4.sig, 401);

  console.log(`\n  SONUC: ${fails === 0 ? 'TUM TESTLER GECTI — F-03 gercek donanimda dogrulandi' : fails + ' test basarisiz'}\n`);
  // process.exit yerine exitCode: bekleyen fetch keep-alive soketleri temiz kapansin
  // (aksi halde Windows'ta zararsiz bir libuv "UV_HANDLE_CLOSING" uyarisi basiliyor).
  process.exitCode = fails === 0 ? 0 : 1;
}

main();
