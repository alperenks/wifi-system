/*
  =============================================================================
  Birim testleri — auth.js  (A2)
  =============================================================================
  Kapsam: scrypt parola doğrulama, HMAC imzalı oturum jetonu üret→doğrula,
  süresi geçmiş jeton reddi, kurcalanmış imza/yük reddi, çerez ayrıştırma,
  requireAuth middleware davranışı (API → 401 JSON, sayfa → /login).

  auth.js diske hiç dokunmaz; kum havuzuna gerek yok.
*/

// Deterministik yapılandırma (dotenv mevcut process.env'i EZMEZ).
process.env.SIM_MODE = 'true';
process.env.ADMIN_SESSION_TTL_MIN = '60';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const config = require('../config');
const auth = require('../auth');

// Jetonun ham yükünü okumak için yardımcı (base64url → utf8).
function decodePayload(token) {
  const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Testin kendi jetonunu üretmesi için (süresi geçmiş jeton kurmak amacıyla).
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function forgeToken(payload, secret = config.admin.sessionSecret) {
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

// --- Parola (scrypt) ---------------------------------------------------------

test('verifyPassword dogru parolayi kabul, yanlisi reddeder', () => {
  const stored = config.hashPassword('KahveVeKod.42');

  assert.strictEqual(auth.verifyPassword('KahveVeKod.42', stored), true);
  assert.strictEqual(auth.verifyPassword('kahveVeKod.42', stored), false, 'buyuk/kucuk harf onemli');
  assert.strictEqual(auth.verifyPassword('', stored), false);
  assert.strictEqual(auth.verifyPassword('KahveVeKod.42 ', stored), false);
});

test('verifyPassword hash bicimi scrypt$salt$hash olmali', () => {
  const stored = config.hashPassword('parola');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
});

test('ayni parola her seferinde farkli salt/hash uretir', () => {
  const a = config.hashPassword('ayniparola');
  const b = config.hashPassword('ayniparola');

  assert.notStrictEqual(a, b, 'salt tekrar kullanilmamali');
  assert.strictEqual(auth.verifyPassword('ayniparola', a), true);
  assert.strictEqual(auth.verifyPassword('ayniparola', b), true);
});

test('verifyPassword bozuk/eksik hash girdisinde cokmez, false doner', () => {
  const cases = [null, undefined, '', 'duzmetin', 'scrypt$saltyok',
    'bcrypt$abc$def', 'scrypt$zz$zz', { hash: 'x' }, 12345];

  for (const stored of cases) {
    assert.strictEqual(auth.verifyPassword('parola', stored), false,
      `bozuk girdi false donmeli: ${String(stored)}`);
  }
});

// --- Jeton üret → doğrula ----------------------------------------------------

test('issueToken uretilen jeton verifyToken ile dogrulanir', () => {
  const token = auth.issueToken('admin');
  const session = auth.verifyToken(token);

  assert.deepStrictEqual(session, { user: 'admin' });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'base64url.base64url bicimi');
});

test('jeton yuku user|exp|nonce icerir ve her jetonda nonce degisir', () => {
  const t1 = auth.issueToken('admin');
  const t2 = auth.issueToken('admin');

  const [user, expStr, nonce] = decodePayload(t1).split('|');
  assert.strictEqual(user, 'admin');
  assert.ok(Number(expStr) > Date.now(), 'exp gelecekte olmali');
  assert.match(nonce, /^[0-9a-f]{16}$/);

  assert.notStrictEqual(t1, t2, 'iki jeton ayni olmamali');
});

test('jeton omru config.admin.sessionTtlMinutes kadar', () => {
  const token = auth.issueToken('admin');
  const exp = Number(decodePayload(token).split('|')[1]);
  const beklenen = Date.now() + config.admin.sessionTtlMinutes * 60 * 1000;

  assert.ok(Math.abs(exp - beklenen) < 5000, 'exp yaklasik TTL kadar ileride olmali');
});

// --- Reddedilmesi gereken jetonlar -------------------------------------------

test('suresi gecmis jeton reddedilir', () => {
  const gecmis = Date.now() - 1000;
  const token = forgeToken(`admin|${gecmis}|deadbeefdeadbeef`);

  assert.strictEqual(auth.verifyToken(token), null);
});

test('kurcalanmis imza reddedilir', () => {
  const token = auth.issueToken('admin');
  const [payload, sig] = token.split('.');

  // İmzanın son karakterini değiştir (aynı uzunluk, farklı bayt).
  const son = sig.slice(-1);
  const bozukSig = sig.slice(0, -1) + (son === 'A' ? 'B' : 'A');

  assert.strictEqual(auth.verifyToken(`${payload}.${bozukSig}`), null);
});

test('kurcalanmis yuk (kullanici degistirme) reddedilir', () => {
  const token = auth.issueToken('admin');
  const sig = token.split('.')[1];
  const exp = Date.now() + 600000;
  const sahteYuk = b64url(`saldirgan|${exp}|deadbeefdeadbeef`);

  assert.strictEqual(auth.verifyToken(`${sahteYuk}.${sig}`), null);
});

test('yanlis sir ile imzalanmis jeton reddedilir', () => {
  const token = forgeToken(`admin|${Date.now() + 600000}|deadbeefdeadbeef`, 'baska-bir-sir');
  assert.strictEqual(auth.verifyToken(token), null);
});

test('bicimsiz jetonlar cokme yapmadan null doner', () => {
  const cases = [null, undefined, '', 'noktayok', '.', 'a.', '.b', 12345, {},
    'a.b.c.d', '!!!.###'];

  for (const t of cases) {
    assert.doesNotThrow(() => auth.verifyToken(t), `cokmemeli: ${String(t)}`);
    assert.strictEqual(auth.verifyToken(t), null, `null donmeli: ${String(t)}`);
  }
});

// --- Çerez -------------------------------------------------------------------

test('getSession cerezden jetonu okuyup oturumu cozer', () => {
  const token = auth.issueToken('admin');
  const req = { headers: { cookie: `theme=dark; ${auth.COOKIE_NAME}=${encodeURIComponent(token)}; x=1` } };

  assert.deepStrictEqual(auth.getSession(req), { user: 'admin' });
});

test('cerez yoksa veya bozuksa getSession null doner', () => {
  assert.strictEqual(auth.getSession({ headers: {} }), null);
  assert.strictEqual(auth.getSession({ headers: { cookie: '' } }), null);
  assert.strictEqual(auth.getSession({ headers: { cookie: 'baska=deger' } }), null);
  assert.strictEqual(auth.getSession({ headers: { cookie: `${auth.COOKIE_NAME}=cop` } }), null);
});

test('setSessionCookie HttpOnly + SameSite=Strict + Max-Age ile yazar', () => {
  let yazilan = null;
  const res = { setHeader: (k, v) => { if (k === 'Set-Cookie') yazilan = v; } };

  auth.setSessionCookie(res, 'jeton-degeri');

  assert.match(yazilan, /^wf_admin=jeton-degeri/);
  assert.match(yazilan, /HttpOnly/);
  assert.match(yazilan, /SameSite=Strict/);
  assert.match(yazilan, new RegExp(`Max-Age=${config.admin.sessionTtlMinutes * 60}`));
  if (!config.tls.enabled) {
    assert.ok(!/Secure/.test(yazilan), 'TLS kapaliyken Secure eklenmemeli');
  }
});

test('clearSessionCookie cerezi Max-Age=0 ile siler', () => {
  let yazilan = null;
  const res = { setHeader: (k, v) => { if (k === 'Set-Cookie') yazilan = v; } };

  auth.clearSessionCookie(res);

  assert.match(yazilan, /^wf_admin=;/);
  assert.match(yazilan, /Max-Age=0/);
});

// --- requireAuth middleware --------------------------------------------------

function sahteRes() {
  const res = { statusCode: null, body: null, redirectedTo: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  res.redirect = (url) => { res.redirectedTo = url; return res; };
  return res;
}

test('requireAuth gecerli oturumda next() cagirir ve adminUser atar', () => {
  const token = auth.issueToken('admin');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${token}` }, originalUrl: '/api/dashboard/sessions' };
  const res = sahteRes();
  let nextCagrildi = false;

  auth.requireAuth(req, res, () => { nextCagrildi = true; });

  assert.strictEqual(nextCagrildi, true);
  assert.strictEqual(req.adminUser, 'admin');
  assert.strictEqual(res.statusCode, null, 'yanit yazilmamali');
});

test('requireAuth oturumsuz API isteginde 401 JSON doner (redirect DEGIL)', () => {
  const req = { headers: {}, originalUrl: '/api/dashboard/clear-logs', url: '/clear-logs' };
  const res = sahteRes();
  let nextCagrildi = false;

  auth.requireAuth(req, res, () => { nextCagrildi = true; });

  assert.strictEqual(nextCagrildi, false);
  assert.strictEqual(res.statusCode, 401);
  assert.ok(res.body && res.body.message, 'JSON mesaj donmeli');
  assert.strictEqual(res.redirectedTo, null);
});

test('requireAuth oturumsuz sayfa isteginde /login\'e yonlendirir', () => {
  const req = { headers: {}, originalUrl: '/dashboard', url: '/dashboard' };
  const res = sahteRes();

  auth.requireAuth(req, res, () => { throw new Error('next cagrilmamaliydi'); });

  assert.strictEqual(res.redirectedTo, '/login');
  assert.strictEqual(res.statusCode, null);
});

test('requireAuth suresi gecmis jetonu oturumsuz sayar', () => {
  const token = forgeToken(`admin|${Date.now() - 1}|deadbeefdeadbeef`);
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${token}` }, originalUrl: '/api/dashboard/sessions' };
  const res = sahteRes();

  auth.requireAuth(req, res, () => { throw new Error('next cagrilmamaliydi'); });

  assert.strictEqual(res.statusCode, 401);
});
