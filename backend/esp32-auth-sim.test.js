/*
  =============================================================================
  esp32-auth-sim.test.js — ESP32 Yetkilendirme Protokolü Yerel Doğrulaması (F-03)
  =============================================================================
  ESP32 firmware'i (esp32-bridge.ino) donanımsız derlenip test edilemez. Bu betik,
  firmware'in /authorize doğrulama MANTIĞINI JS'te birebir yansıtır ve backend'in
  ürettiği imzayla uçtan uca sınar:

    - Geçerli imzalı istek        -> KABUL
    - İmzasız / yanlış imza       -> RED (bad_signature)
    - Aynı nonce tekrarı (replay) -> RED (replay)
    - Eski zaman damgası (stale)  -> RED (stale)

  Böylece protokolün doğruluğu, gerçek donanım gelmeden kanıtlanmış olur.
  Firmware bu mantığı mbedTLS ile C++ tarafında uygular.

  Kullanım:  node esp32-auth-sim.test.js
*/

const crypto = require('crypto');

const SECRET = 'test-shared-secret-1234567890';
const CLOCK_TOLERANCE_SEC = 30;

// --- ESP32 tarafının aynası ---
function makeVerifier() {
  const seenNonces = [];
  let lastAcceptedTs = 0;
  const NONCE_RING = 16;

  function constEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  return function verify(body, signature) {
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    if (!signature || !constEq(signature, expected)) return { ok: false, error: 'bad_signature' };

    let obj;
    try { obj = JSON.parse(body); } catch (_) { return { ok: false, error: 'bad_body' }; }
    const { mac, ts, nonce } = obj;
    if (!mac || !ts || !nonce) return { ok: false, error: 'bad_body' };

    if (seenNonces.includes(nonce)) return { ok: false, error: 'replay' };
    if (lastAcceptedTs > 0 && ts < lastAcceptedTs - CLOCK_TOLERANCE_SEC) return { ok: false, error: 'stale' };

    seenNonces.push(nonce);
    if (seenNonces.length > NONCE_RING) seenNonces.shift();
    if (ts > lastAcceptedTs) lastAcceptedTs = ts;
    return { ok: true };
  };
}

// --- Backend tarafının aynası (server.js notifyEsp32Authorize) ---
function signRequest(mac, ts, nonce) {
  const body = JSON.stringify({ mac, ts, nonce });
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return { body, signature };
}

function assert(cond, label) {
  if (cond) { console.log(`  [OK]   ${label}`); return 0; }
  console.log(`  [FAIL] ${label}`);
  return 1;
}

function main() {
  console.log('\n  ESP32 /authorize protokol testi (firmware mantiginin JS aynasi)\n');
  const verify = makeVerifier();
  let fails = 0;
  const now = Math.floor(Date.now() / 1000);

  // 1) Geçerli istek kabul edilmeli
  const r1 = signRequest('aabbccddeeff', now, crypto.randomBytes(8).toString('hex'));
  fails += assert(verify(r1.body, r1.signature).ok === true, 'Gecerli imzali istek KABUL edildi');

  // 2) İmzasız istek reddedilmeli
  fails += assert(verify(r1.body, '').error === 'bad_signature', 'Imzasiz istek REDDEDILDI');

  // 3) Yanlış imza reddedilmeli
  fails += assert(verify(r1.body, 'deadbeef'.repeat(8)).error === 'bad_signature', 'Yanlis imza REDDEDILDI');

  // 4) Aynı isteği tekrar oynatma (replay) reddedilmeli
  fails += assert(verify(r1.body, r1.signature).error === 'replay', 'Replay (ayni nonce) REDDEDILDI');

  // 5) Eski zaman damgalı istek reddedilmeli
  const rOld = signRequest('aabbccddeeff', now - 120, crypto.randomBytes(8).toString('hex'));
  fails += assert(verify(rOld.body, rOld.signature).error === 'stale', 'Eski zaman damgasi (stale) REDDEDILDI');

  // 6) Yeni nonce + güncel ts tekrar kabul edilmeli
  const r6 = signRequest('112233445566', now + 1, crypto.randomBytes(8).toString('hex'));
  fails += assert(verify(r6.body, r6.signature).ok === true, 'Yeni gecerli istek KABUL edildi');

  console.log(`\n  SONUC: ${fails === 0 ? 'TUM TESTLER GECTI' : fails + ' TEST BASARISIZ'}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
