/*
  =============================================================================
  Birim testleri — errors.js  (D4)
  =============================================================================
  Kapsam: eşleşmeyen /api/* için JSON 404, bozuk JSON gövdesi için 400,
  beklenmeyen hata için 500 + YIĞIN İZİ SIZMAMASI, async route hatalarının
  merkezi katmana ulaşması.
*/

const test = require('node:test');
const assert = require('node:assert');

const { apiNotFound, makeErrorHandler, wrapAsync } = require('../errors');

function sahteRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; res.headersSent = true; return res; };
  return res;
}

// Logger'ı yakalayıp konsolu kirletmeden ne yazıldığını inceleyebiliriz.
function yakalayanHandler() {
  const kayitlar = [];
  const handler = makeErrorHandler((...args) => kayitlar.push(args.map(String).join(' ')));
  return { handler, kayitlar };
}

// --- 404 ---------------------------------------------------------------------

test('eslesmeyen /api yolu JSON 404 doner', () => {
  const res = sahteRes();
  apiNotFound({ originalUrl: '/api/boyle-bir-sey-yok' }, res, () => {
    throw new Error('next cagrilmamaliydi');
  });

  assert.strictEqual(res.statusCode, 404);
  assert.match(res.body.message, /uç nokta/i);
  assert.strictEqual(res.body.path, '/api/boyle-bir-sey-yok');
});

test('API disi yollar 404 katmanina takilmaz (sayfalar Express\'e kalir)', () => {
  const res = sahteRes();
  let devam = false;
  apiNotFound({ originalUrl: '/captive' }, res, () => { devam = true; });

  assert.strictEqual(devam, true);
  assert.strictEqual(res.statusCode, null);
});

// --- Bozuk JSON / büyük gövde ------------------------------------------------

test('bozuk JSON govdesi HTML degil JSON 400 doner', () => {
  const { handler, kayitlar } = yakalayanHandler();
  const res = sahteRes();
  const err = Object.assign(new SyntaxError('Unexpected token b in JSON'), {
    type: 'entity.parse.failed', body: '{bozuk',
  });

  handler(err, { originalUrl: '/api/verify-otp' }, res, () => {});

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { message: 'Geçersiz JSON gövdesi.' });
  assert.strictEqual(kayitlar.length, 1, 'sunucu tarafina loglanmali');
});

test('cok buyuk govde 413 doner', () => {
  const { handler } = yakalayanHandler();
  const res = sahteRes();

  handler(Object.assign(new Error('too large'), { type: 'entity.too.large' }),
    { originalUrl: '/api/send-otp' }, res, () => {});

  assert.strictEqual(res.statusCode, 413);
});

// --- 4xx / 500 ---------------------------------------------------------------

test('durum kodu tasiyan hata o kodla doner, mesaji expose degilse gizlenir', () => {
  const { handler } = yakalayanHandler();

  const gizli = sahteRes();
  handler(Object.assign(new Error('ic detay'), { status: 403 }),
    { originalUrl: '/api/x' }, gizli, () => {});
  assert.strictEqual(gizli.statusCode, 403);
  assert.strictEqual(gizli.body.message, 'İstek reddedildi.');
  assert.ok(!/ic detay/.test(JSON.stringify(gizli.body)));

  const acik = sahteRes();
  handler(Object.assign(new Error('gorunur mesaj'), { status: 400, expose: true }),
    { originalUrl: '/api/x' }, acik, () => {});
  assert.strictEqual(acik.body.message, 'gorunur mesaj');
});

test('beklenmeyen hata 500 doner ve YIGIN IZI sizdirmaz', () => {
  const { handler, kayitlar } = yakalayanHandler();
  const res = sahteRes();
  const err = new Error('veritabani patladi');

  handler(err, { originalUrl: '/api/dashboard/sessions' }, res, () => {});

  assert.strictEqual(res.statusCode, 500);
  const govde = JSON.stringify(res.body);
  assert.ok(!govde.includes('veritabani patladi'), 'hata mesaji istemciye gitmemeli');
  assert.ok(!govde.includes('errors.test.js'), 'stack istemciye gitmemeli');
  assert.ok(!/at /.test(govde), 'stack satiri istemciye gitmemeli');

  // Ayrıntı sunucu tarafında OLMALI — teşhis kaybolmasın.
  assert.ok(kayitlar[0].includes('veritabani patladi'));
});

test('yanit zaten baslamissa hata Express\'e devredilir', () => {
  const { handler } = yakalayanHandler();
  const res = sahteRes();
  res.headersSent = true;
  let devredildi = false;

  handler(new Error('gec kalan hata'), { originalUrl: '/api/x' }, res, () => { devredildi = true; });

  assert.strictEqual(devredildi, true);
  assert.strictEqual(res.statusCode, null);
});

// --- wrapAsync ---------------------------------------------------------------

test('wrapAsync reddedilen promise\'i next(err) ile iletir', async () => {
  const patlayan = wrapAsync(async () => { throw new Error('async patlama'); });
  let yakalanan = null;

  patlayan({}, sahteRes(), (err) => { yakalanan = err; });
  await new Promise(r => setImmediate(r));

  assert.ok(yakalanan instanceof Error);
  assert.strictEqual(yakalanan.message, 'async patlama');
});

test('wrapAsync basarili handler\'i etkilemez', async () => {
  const res = sahteRes();
  const iyi = wrapAsync(async (req, r) => { r.status(200).json({ ok: true }); });

  iyi({}, res, () => { throw new Error('next cagrilmamaliydi'); });
  await new Promise(r => setImmediate(r));

  assert.deepStrictEqual(res.body, { ok: true });
});
