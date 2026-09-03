/*
  =============================================================================
  Birim testleri — validate.js  (D3)
  =============================================================================
  Kapsam: MAC/telefon/OTP/IP/tam sayı/metin tip kontrolleri, zorunlu alan,
  beklenmeyen alan reddi, bozuk gövde (dizi/null) reddi ve middleware'in
  400 + alan adı döndürmesi.
*/

const test = require('node:test');
const assert = require('node:assert');

const { checkBody, validateBody, normalizePhone } = require('../validate');

// --- MAC ---------------------------------------------------------------------

test('MAC alani yaygin bicimleri kabul eder', () => {
  const schema = { mac: { type: 'mac', required: true } };
  for (const mac of ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabbccddeeff', 'AA:BB:CC:DD:EE:01']) {
    assert.strictEqual(checkBody({ mac }, schema), null, `kabul edilmeliydi: ${mac}`);
  }
});

test('bozuk MAC reddedilir', () => {
  const schema = { mac: { type: 'mac', required: true } };
  for (const mac of ['zz:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee', 'aabbccddeeff00', '', 12345, { a: 1 },
    "aa:bb:cc:dd:ee:ff' OR 1=1"]) {
    const hata = checkBody({ mac }, schema);
    assert.ok(hata, `reddedilmeliydi: ${String(mac)}`);
    assert.strictEqual(hata.field, 'mac');
  }
});

// --- Telefon / OTP / IP ------------------------------------------------------

test('telefon 5XXXXXXXXX bicimini zorunlu kilar', () => {
  const schema = { phone: { type: 'phone', required: true } };
  assert.strictEqual(checkBody({ phone: '5551112233' }, schema), null);
  assert.strictEqual(checkBody({ phone: '555 111 22 33' }, schema), null, 'bosluklar temizlenir');

  for (const phone of ['05551112233', '4441112233', '555111223', '55511122334', 'abcdefghij']) {
    assert.ok(checkBody({ phone }, schema), `reddedilmeliydi: ${phone}`);
  }
});

test('OTP tam olarak 6 hane olmali', () => {
  const schema = { otp: { type: 'otp', required: true } };
  assert.strictEqual(checkBody({ otp: '123456' }, schema), null);
  assert.strictEqual(checkBody({ otp: 123456 }, schema), null, 'sayi da kabul edilir');

  for (const otp of ['12345', '1234567', '12345a', ' 123456', '', null]) {
    assert.ok(checkBody({ otp }, schema), `reddedilmeliydi: ${String(otp)}`);
  }
});

test('IPv4 dogrulamasi sinirlari korur', () => {
  const schema = { ip: { type: 'ip', required: true } };
  assert.strictEqual(checkBody({ ip: '192.168.20.100' }, schema), null);
  assert.strictEqual(checkBody({ ip: '0.0.0.0' }, schema), null);

  for (const ip of ['192.168.20', '192.168.20.256', '192.168.20.1.5', '::1', 'localhost', '192.168.20.-1']) {
    assert.ok(checkBody({ ip }, schema), `reddedilmeliydi: ${ip}`);
  }
});

// --- Sayı / metin ------------------------------------------------------------

test('int alani aralik disini reddeder', () => {
  const schema = { count: { type: 'int', min: 1, max: 25 } };
  assert.strictEqual(checkBody({ count: 5 }, schema), null);
  assert.strictEqual(checkBody({ count: '5' }, schema), null, 'sayiya cevrilebilen metin kabul');

  assert.ok(checkBody({ count: 0 }, schema));
  assert.ok(checkBody({ count: 26 }, schema));
  assert.ok(checkBody({ count: 2.5 }, schema));
  assert.ok(checkBody({ count: 'bes' }, schema));
});

test('string alani uzunluk ve izinli deger listesini uygular', () => {
  assert.strictEqual(checkBody({ type: 'dns' }, { type: { type: 'string', values: ['dns', 'nat'] } }), null);
  assert.ok(checkBody({ type: 'ftp' }, { type: { type: 'string', values: ['dns', 'nat'] } }));
  assert.ok(checkBody({ user: 'a'.repeat(65) }, { user: { type: 'string', maxLength: 64 } }));
});

// --- Zorunluluk / beklenmeyen alan ------------------------------------------

test('zorunlu alan eksikse reddedilir, opsiyonel eksikse gecer', () => {
  const schema = { mac: { type: 'mac', required: true }, phone: { type: 'phone' } };

  assert.strictEqual(checkBody({ mac: 'aabbccddeeff' }, schema), null);
  assert.deepStrictEqual(checkBody({ phone: '5551112233' }, schema),
    { field: 'mac', reason: 'zorunlu alan' });
  assert.deepStrictEqual(checkBody({ mac: '' }, schema),
    { field: 'mac', reason: 'zorunlu alan' });
});

test('semada olmayan alan sessizce yutulmaz, reddedilir', () => {
  const schema = { mac: { type: 'mac', required: true } };
  const hata = checkBody({ mac: 'aabbccddeeff', isAdmin: true }, schema);

  assert.deepStrictEqual(hata, { field: 'isAdmin', reason: 'beklenmeyen alan' });
});

test('bos sema yalnizca bos govdeyi kabul eder', () => {
  assert.strictEqual(checkBody({}, {}), null);
  assert.ok(checkBody({ herhangi: 1 }, {}));
});

test('nesne olmayan govde reddedilir (cokme yok)', () => {
  for (const body of [null, undefined, [], [1, 2], 'metin', 42]) {
    const hata = checkBody(body, { mac: { type: 'mac' } });
    assert.ok(hata, `reddedilmeliydi: ${JSON.stringify(body)}`);
  }
});

// --- Middleware --------------------------------------------------------------

function sahteRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

test('validateBody gecerli govdede next() cagirir', () => {
  const mw = validateBody({ mac: { type: 'mac', required: true } });
  const res = sahteRes();
  let cagrildi = false;

  mw({ body: { mac: 'aa:bb:cc:dd:ee:ff' } }, res, () => { cagrildi = true; });

  assert.strictEqual(cagrildi, true);
  assert.strictEqual(res.statusCode, null);
});

test('validateBody hatali govdede 400 + alan adi doner', () => {
  const mw = validateBody({ mac: { type: 'mac', required: true } });
  const res = sahteRes();

  mw({ body: { mac: 'gecersiz' } }, res, () => { throw new Error('next cagrilmamaliydi'); });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.field, 'mac');
  assert.match(res.body.message, /mac/);
});

// --- Telefon alanı üzerinden enjeksiyon (güvenlik denetimi bulgusu) ----------

test('telefon alanina gomulen 5651 log satiri REDDEDILIR', () => {
  const sema = { phone: { type: 'phone', required: true } };

  // Rakamsiz kuyruk: eski "rakam disi her seyi sil" mantiginda dogrulamadan geciyordu.
  const enjeksiyon = '5551112233\nSAHTE | NAT | aa | bb | cc | dd | ee | ff | Proto: TCP';
  assert.ok(checkBody({ phone: enjeksiyon }, sema), 'satir sonu iceren deger reddedilmeli');

  const xss = '5551112233<img src=x onerror=alert(1)>';
  assert.ok(checkBody({ phone: xss }, sema), 'HTML iceren deger reddedilmeli');

  const ayrac = '5551112233 | sahte';
  assert.ok(checkBody({ phone: ayrac }, sema), 'ayrac iceren deger reddedilmeli');
});

test('normalizePhone yalnizca ayraclari temizler, kanonik 10 hane doner', () => {
  assert.strictEqual(normalizePhone('5551112233'), '5551112233');
  assert.strictEqual(normalizePhone('555 111 22 33'), '5551112233');
  assert.strictEqual(normalizePhone('(555) 111-22.33'), '5551112233');
  assert.strictEqual(normalizePhone('  5551112233\n'), '5551112233',
    'bastaki/sondaki bosluk kirpilir — icerideki metin degil');

  for (const kotu of ['05551112233', '5551112233x', '5551112233|x', '5551112233<b>', '', null, undefined, {}]) {
    assert.strictEqual(normalizePhone(kotu), null, `reddedilmeliydi: ${String(kotu)}`);
  }
});

test('int alani boolean kabul etmez', () => {
  const sema = { count: { type: 'int', min: 1, max: 25 } };
  assert.ok(checkBody({ count: true }, sema), 'true tam sayi degildir');
  assert.ok(checkBody({ count: false }, sema));
  assert.ok(checkBody({ count: [] }, sema));
  assert.strictEqual(checkBody({ count: 5 }, sema), null);
});
