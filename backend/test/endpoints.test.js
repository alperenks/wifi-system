/*
  =============================================================================
  Uç nokta (HTTP) testleri — server.js  (G5)
  =============================================================================
  Birim testleri tek tek parçaları sınıyor; burada GERÇEK bir Express sunucusu
  rastgele bir portta ayağa kalkıyor ve gerçek HTTP istekleri atılıyor. Böylece
  ara katman zinciri (hız sınırı → gövde doğrulama → kimlik → hata katmanı)
  bir bütün olarak sınanmış oluyor. Ek bağımlılık yok: Node'un yerleşik fetch'i.

  Sunucu `require` edildiğinde dinlemeye BAŞLAMAZ (require.main koruması), bu
  yüzden RADIUS/Syslog/cron kalkmaz; testler yalnızca HTTP katmanını konuşur.

  ÖNEMLİ: db.json ve logs/ kum havuzunda — gerçek veriye dokunulmaz.
*/

const path = require('path');
const { sandboxJsonFile, sandboxDir } = require('./_sandbox');

sandboxJsonFile(path.join(__dirname, '..', 'db.json'), {
  guestFlows: [], radcheck: {}, radreply: {}, radacct: [], leases: {},
});
const sandbox = sandboxDir(path.join(__dirname, '..', 'logs', '5651_captive'));

// Deterministik yapılandırma. Hız sınırlarını testin kendi akışı tetiklemesin
// diye bilerek yükseltiyoruz; sınırların KENDİSİ attack.js ile sınanıyor.
process.env.SIM_MODE = 'true';
process.env.RL_OTP_PER_MIN = '50';
process.env.RL_OTP_PER_HOUR = '50';
process.env.RL_OTP_PER_PHONE_DAY = '50';
process.env.RL_VERIFY_PER_MIN = '50';
process.env.RL_LOGIN_PER_15MIN = '50';
process.env.ADMIN_PASSWORD = 'test-parola-123';
process.env.QUOTA_MB = '0';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../config');
const db = require('../db');
const { app } = require('../server');

let server;
let BASE;

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  sandbox.cleanup();
});

// --- Yardımcılar -------------------------------------------------------------

function get(yol, cerez) {
  return fetch(BASE + yol, { headers: cerez ? { Cookie: cerez } : {}, redirect: 'manual' });
}

function post(yol, govde, cerez) {
  return fetch(BASE + yol, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cerez ? { Cookie: cerez } : {}) },
    body: typeof govde === 'string' ? govde : JSON.stringify(govde ?? {}),
    redirect: 'manual',
  });
}

async function yoneticiCerezi() {
  const r = await post('/api/auth/login', { user: config.admin.user, password: 'test-parola-123' });
  assert.strictEqual(r.status, 200, 'yonetici girisi basarili olmali');
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

// --- Kimlik doğrulaması gerektirmeyen uçlar ----------------------------------

test('GET /api/health kimlik dogrulamasiz 200 doner', async () => {
  const r = await get('/api/health');
  const j = await r.json();

  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.status, 'ok');
  assert.strictEqual(j.mode, 'simulation');
  assert.strictEqual(typeof j.activeSessions, 'number');
  assert.ok(!('password' in j) && !('secret' in j), 'sir sizdirmamali');
});

test('GET /api/config panel icin gerekli ayarlari doner', async () => {
  const j = await (await get('/api/config')).json();

  assert.strictEqual(j.simMode, true);
  assert.strictEqual(j.quotaMb, 0);
  assert.strictEqual(j.lanPrefix, config.session.lanPrefix);
  assert.ok(!JSON.stringify(j).includes('scrypt$'), 'parola hash\'i sizmamali');
});

test('GET /captive misafir portalini servis eder', async () => {
  const r = await get('/captive');
  const html = await r.text();

  assert.strictEqual(r.status, 200);
  assert.match(html, /<title>/i);
});

// --- Yetkilendirme -----------------------------------------------------------

test('cerezsiz /api/dashboard/* 401 JSON doner (yonlendirme DEGIL)', async () => {
  for (const yol of ['/api/dashboard/sessions', '/api/dashboard/logs', '/api/dashboard/search?q=5']) {
    const r = await get(yol);
    assert.strictEqual(r.status, 401, yol);
    const j = await r.json();
    assert.match(j.message, /Yetkisiz/);
  }
});

test('cerezsiz /dashboard sayfasi /login e yonlendirir', async () => {
  const r = await get('/dashboard');

  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
});

test('yanlis parola 401, dogru parola cerez doner', async () => {
  const yanlis = await post('/api/auth/login', { user: config.admin.user, password: 'yanlis' });
  assert.strictEqual(yanlis.status, 401);

  const dogru = await post('/api/auth/login', { user: config.admin.user, password: 'test-parola-123' });
  assert.strictEqual(dogru.status, 200);
  const cerez = dogru.headers.get('set-cookie');
  assert.match(cerez, /wf_admin=/);
  assert.match(cerez, /HttpOnly/);
});

test('gecerli cerezle oturum listesi okunur', async () => {
  const cerez = await yoneticiCerezi();
  const r = await get('/api/dashboard/sessions', cerez);

  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(await r.json()));
});

// --- Gövde doğrulama (D3) ----------------------------------------------------

test('bozuk MAC/OTP gonderimi 400 + alan adi doner', async () => {
  const kotu = await post('/api/verify-otp', { mac: 'gecersiz', otp: '123456' });
  assert.strictEqual(kotu.status, 400);
  assert.strictEqual((await kotu.json()).field, 'mac');

  const kisaOtp = await post('/api/verify-otp', { mac: 'aa:bb:cc:dd:ee:ff', otp: '12' });
  assert.strictEqual(kisaOtp.status, 400);
  assert.strictEqual((await kisaOtp.json()).field, 'otp');
});

test('beklenmeyen alan reddedilir (sessizce yutulmaz)', async () => {
  const r = await post('/api/verify-otp', { mac: 'aa:bb:cc:dd:ee:ff', otp: '123456', isAdmin: true });

  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).field, 'isAdmin');
});

test('telefon bicimi zorunlu (0 ile baslayan numara reddedilir)', async () => {
  const r = await post('/api/send-otp', { mac: 'aa:bb:cc:dd:ee:01', phone: '05551112233' });

  assert.strictEqual(r.status, 400);
});

// --- Hata katmanı (D4) -------------------------------------------------------

test('olmayan /api ucu JSON 404 doner', async () => {
  const r = await get('/api/boyle-bir-uc-yok');

  assert.strictEqual(r.status, 404);
  assert.match((await r.json()).message, /uç nokta/i);
});

test('bozuk JSON govdesi HTML degil JSON 400 doner (stack sizmaz)', async () => {
  const r = await post('/api/verify-otp', '{bozuk json');
  const metin = await r.text();

  assert.strictEqual(r.status, 400);
  assert.doesNotThrow(() => JSON.parse(metin), 'yanit JSON olmali');
  assert.ok(!metin.includes('SyntaxError'), 'hata sinifi sizmamali');
  assert.ok(!/at .*server\.js/.test(metin), 'stack sizmamali');
});

// --- OTP akışı (RADIUS'suz kısmı) --------------------------------------------

test('SIM_MODE de send-otp kodu dondurur ve akis olusur', async () => {
  const mac = 'aa:bb:cc:dd:ee:10';
  const r = await post('/api/send-otp', { mac, phone: '5551112233' });
  const j = await r.json();

  assert.strictEqual(r.status, 200);
  assert.match(String(j.otpCode), /^[0-9]{6}$/, 'SIM modunda kod arayuze doner');

  const akis = db.data.guestFlows.find(f => f.mac === 'aabbccddee10');
  assert.ok(akis, 'akis kaydi olusmali');
  assert.ok(!('otp' in akis), 'duz metin OTP saklanmamali');
});

test('yanlis OTP 400 ve kalan deneme sayisi doner', async () => {
  const mac = 'aa:bb:cc:dd:ee:11';
  await post('/api/send-otp', { mac, phone: '5551112244' });

  const r = await post('/api/verify-otp', { mac, otp: '000000' });
  const j = await r.json();

  assert.strictEqual(r.status, 400);
  assert.strictEqual(typeof j.remaining, 'number');
  assert.ok(j.remaining < config.security.otp.maxAttempts);
});

test('cok fazla yanlis denemede akis kilitlenir (429 + locked)', async () => {
  const mac = 'aa:bb:cc:dd:ee:12';
  await post('/api/send-otp', { mac, phone: '5551112255' });

  let son;
  for (let i = 0; i < config.security.otp.maxAttempts; i++) {
    son = await post('/api/verify-otp', { mac, otp: '000000' });
  }
  const j = await son.json();

  assert.strictEqual(son.status, 429);
  assert.strictEqual(j.locked, true);
  assert.strictEqual(j.remaining, 0);
});

// --- Log uçları (G3/G4) ------------------------------------------------------

test('logs ucu varsayilan olarak sinirli sayida satir doner', async () => {
  const cerez = await yoneticiCerezi();
  const j = await (await get('/api/dashboard/logs', cerez)).json();

  assert.strictEqual(typeof j.logs, 'string');
  assert.strictEqual(typeof j.returnedLines, 'number');
  assert.strictEqual(j.truncated, false, 'kum havuzunda log yok — kirpma olmamali');
});

test('logs ucu gecersiz tail degerini 400 ile reddeder', async () => {
  const cerez = await yoneticiCerezi();
  const r = await get('/api/dashboard/logs?tail=-5', cerez);

  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).field, 'tail');
});

test('search ucu gecersiz tarihi 400 ile reddeder', async () => {
  const cerez = await yoneticiCerezi();

  const bozuk = await get('/api/dashboard/search?q=555&from=03-09-2026', cerez);
  assert.strictEqual(bozuk.status, 400);
  assert.strictEqual((await bozuk.json()).field, 'from');

  const ters = await get('/api/dashboard/search?q=555&from=2026-09-05&to=2026-09-01', cerez);
  assert.strictEqual(ters.status, 400);
});

test('search bos sorguda bos sonuc doner (dosya taramaz)', async () => {
  const cerez = await yoneticiCerezi();
  const j = await (await get('/api/dashboard/search?q=', cerez)).json();

  assert.deepStrictEqual(j.matches, []);
  assert.strictEqual(j.scannedFiles, 0);
});
