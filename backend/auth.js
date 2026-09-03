/*
  =============================================================================
  auth.js — Yönetici Kimlik Doğrulama (F-12)
  =============================================================================
  Yönetim arayüzü (/dashboard) ve yönetim API'leri için oturum tabanlı kimlik
  doğrulama. Harici bağımlılık yok — parola hash'i scrypt, oturum jetonu HMAC
  imzalı, çerez ayrıştırması elle yapılır.

  Jeton biçimi:  base64url(user|exp|nonce) + "." + base64url(HMAC-SHA256(payload))
  Doğrulama:     imza sabit-zamanlı karşılaştırılır, sonra son kullanma kontrol edilir.
*/

const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'wf_admin';

// --- Parola --------------------------------------------------------------
// Biçim: scrypt$<saltHex>$<hashHex>
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, 64);
  } catch (_) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// --- Jeton ---------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return crypto.createHmac('sha256', config.admin.sessionSecret).update(payload).digest();
}

function issueToken(user) {
  const exp = Date.now() + config.admin.sessionTtlMinutes * 60 * 1000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${user}|${exp}|${nonce}`;
  const sig = sign(payload);
  return `${b64url(payload)}.${b64url(sig)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  let payload, providedSig;
  try {
    payload = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    providedSig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch (_) {
    return null;
  }
  const expectedSig = sign(payload);
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

  const [user, expStr] = payload.split('|');
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { user };
}

// --- Çerez ---------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${config.admin.sessionTtlMinutes * 60}`,
  ];
  if (config.tls.enabled) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return verifyToken(token);
}

// --- Middleware ----------------------------------------------------------
// API isteğinde 401 JSON döner; sayfa isteğinde /login'e yönlendirir.
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) {
    req.adminUser = session.user;
    return next();
  }
  // req.path, app.use('/api/dashboard', ...) ile monte edildiğinde mount'a görelidir
  // ('/clear-logs' gibi). Tam yolu görmek için originalUrl kullanılır — API isteği
  // 401 JSON almalı (redirect DEĞİL), sayfa isteği /login'e yönlenmeli.
  const isApi = (req.originalUrl || req.url || '').startsWith('/api/');
  if (isApi) {
    return res.status(401).json({ message: 'Yetkisiz. Yönetici girişi gerekli.' });
  }
  return res.redirect('/login');
}

module.exports = {
  COOKIE_NAME,
  verifyPassword,
  issueToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAuth,
};
