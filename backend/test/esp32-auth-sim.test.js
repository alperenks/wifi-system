/*
  =============================================================================
  ESP32 Yetkilendirme Protokolü Yerel Doğrulaması (F-03)  — node:test sürümü
  =============================================================================
  ESP32 firmware'i (esp32-bridge.ino) donanımsız derlenip test edilemez. Bu dosya,
  firmware'in /authorize doğrulama MANTIĞINI JS'te birebir yansıtır ve backend'in
  ürettiği imzayla uçtan uca sınar:

    - Geçerli imzalı istek        -> KABUL
    - İmzasız / yanlış imza       -> RED (bad_signature)
    - Aynı nonce tekrarı (replay) -> RED (replay)
    - Eski zaman damgası (stale)  -> RED (stale)

  Böylece protokolün doğruluğu, gerçek donanım gelmeden kanıtlanmış olur.
  Firmware bu mantığı mbedTLS ile C++ tarafında uygular.

  (H4) Eskiden kendi `main()`/`process.exit`'i olan ayrı bir betikti; artık
  `npm test` ile birlikte koşuyor. Yalnızca bunu koşmak için: `npm run test:esp32`.
  Gerçek donanımla yapılan test ayrıdır: `esp32-hw-test.js` / `esp32-hw-test.bat`.
*/

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

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

const nonce = () => crypto.randomBytes(8).toString('hex');
const simdi = () => Math.floor(Date.now() / 1000);

// --- Testler -----------------------------------------------------------------

test('gecerli imzali istek KABUL edilir', () => {
  const verify = makeVerifier();
  const r = signRequest('aabbccddeeff', simdi(), nonce());

  assert.deepStrictEqual(verify(r.body, r.signature), { ok: true });
});

test('imzasiz istek REDDEDILIR', () => {
  const verify = makeVerifier();
  const r = signRequest('aabbccddeeff', simdi(), nonce());

  assert.strictEqual(verify(r.body, '').error, 'bad_signature');
  assert.strictEqual(verify(r.body, null).error, 'bad_signature');
  assert.strictEqual(verify(r.body, undefined).error, 'bad_signature');
});

test('yanlis imza REDDEDILIR', () => {
  const verify = makeVerifier();
  const r = signRequest('aabbccddeeff', simdi(), nonce());

  assert.strictEqual(verify(r.body, 'deadbeef'.repeat(8)).error, 'bad_signature');
  assert.strictEqual(verify(r.body, r.signature.slice(0, -1) + '0').error, 'bad_signature',
    'tek karakter degisse bile reddedilmeli');
});

test('govde kurcalanirsa imza tutmaz (MAC degistirme denemesi)', () => {
  const verify = makeVerifier();
  const r = signRequest('aabbccddeeff', simdi(), nonce());
  const sahteGovde = r.body.replace('aabbccddeeff', 'ffffffffffff');

  assert.strictEqual(verify(sahteGovde, r.signature).error, 'bad_signature');
});

test('ayni nonce tekrar oynatilamaz (replay)', () => {
  const verify = makeVerifier();
  const r = signRequest('aabbccddeeff', simdi(), nonce());

  assert.strictEqual(verify(r.body, r.signature).ok, true);
  assert.strictEqual(verify(r.body, r.signature).error, 'replay', 'ikinci kez kabul edilmemeli');
});

test('eski zaman damgali istek REDDEDILIR (stale)', () => {
  const verify = makeVerifier();
  const now = simdi();

  assert.strictEqual(verify(...Object.values(signRequest('aabbccddeeff', now, nonce()))).ok, true);

  const eski = signRequest('aabbccddeeff', now - 120, nonce());
  assert.strictEqual(verify(eski.body, eski.signature).error, 'stale');
});

test('saat toleransi icindeki kucuk sapma kabul edilir', () => {
  const verify = makeVerifier();
  const now = simdi();

  const ilk = signRequest('aabbccddeeff', now, nonce());
  assert.strictEqual(verify(ilk.body, ilk.signature).ok, true);

  // 10 sn geride ama tolerans (30 sn) içinde
  const sapmali = signRequest('aabbccddeeff', now - 10, nonce());
  assert.strictEqual(verify(sapmali.body, sapmali.signature).ok, true);
});

test('yeni nonce + guncel zaman damgasi tekrar KABUL edilir', () => {
  const verify = makeVerifier();
  const now = simdi();

  const ilk = signRequest('aabbccddeeff', now, nonce());
  verify(ilk.body, ilk.signature);

  const yeni = signRequest('112233445566', now + 1, nonce());
  assert.strictEqual(verify(yeni.body, yeni.signature).ok, true);
});

test('eksik alanli govde REDDEDILIR', () => {
  const verify = makeVerifier();

  for (const govde of [
    JSON.stringify({ ts: simdi(), nonce: nonce() }),          // mac yok
    JSON.stringify({ mac: 'aabbccddeeff', nonce: nonce() }),  // ts yok
    JSON.stringify({ mac: 'aabbccddeeff', ts: simdi() }),     // nonce yok
  ]) {
    const imza = crypto.createHmac('sha256', SECRET).update(govde).digest('hex');
    assert.strictEqual(verify(govde, imza).error, 'bad_body', govde);
  }
});

test('bozuk JSON govdesi cokme yapmadan REDDEDILIR', () => {
  const verify = makeVerifier();
  const govde = '{bozuk json';
  const imza = crypto.createHmac('sha256', SECRET).update(govde).digest('hex');

  let sonuc;
  assert.doesNotThrow(() => { sonuc = verify(govde, imza); });
  assert.strictEqual(sonuc.error, 'bad_body');
});

test('nonce halkasi dolsa da son istekler replay olarak yakalanir', () => {
  const verify = makeVerifier();
  const now = simdi();
  const sonuncu = signRequest('aabbccddeeff', now + 20, nonce());

  // Halkayı (16) dolduracak kadar geçerli istek
  for (let i = 0; i < 16; i++) {
    const r = signRequest('aabbccddeeff', now + i, nonce());
    assert.strictEqual(verify(r.body, r.signature).ok, true, `istek ${i} kabul edilmeliydi`);
  }

  assert.strictEqual(verify(sonuncu.body, sonuncu.signature).ok, true);
  assert.strictEqual(verify(sonuncu.body, sonuncu.signature).error, 'replay',
    'en son nonce halkada durmali');
});
