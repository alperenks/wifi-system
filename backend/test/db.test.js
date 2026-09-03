/*
  =============================================================================
  Birim testleri — db.js  (A1)
  =============================================================================
  Kapsam: OTP hash+salt saklama (F-06), yanlış deneme sayacı ve kilit (F-01),
  sabit zamanlı karşılaştırma yolu, oturum sırrı üretimi (F-04),
  saklama temizliği (F-07), DHCP kirası ve IP→telefon çözümlemesi.

  ÖNEMLİ: gerçek `backend/db.json` dosyasına dokunulmaz — _sandbox.js ile
  fs katmanı bellek içi tampona yönlendirilir (require'dan ÖNCE).
*/

const path = require('path');
const { sandboxJsonFile } = require('./_sandbox');

// 1) db.json'u kum havuzuna al — db.js yüklenirken bunu okuyacak.
sandboxJsonFile(path.join(__dirname, '..', 'db.json'), {
  guestFlows: [], radcheck: {}, radreply: {}, radacct: [], leases: {},
});

// 2) Test için deterministik yapılandırma (dotenv mevcut process.env'i EZMEZ).
process.env.SIM_MODE = 'true';
process.env.OTP_MAX_ATTEMPTS = '3';
process.env.OTP_EXPIRE_MINUTES = '3';
process.env.OTP_FLOW_RETENTION_HOURS = '1';
process.env.RETENTION_SESSION_DAYS = '1';
process.env.LAN_PREFIX = '192.168.20';
process.env.LEASE_START = '100';
process.env.LEASE_END = '102';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const config = require('../config');
const db = require('../db');

const MAX = config.security.otp.maxAttempts;   // 3

// Her testten önce temiz durum.
test.beforeEach(() => {
  db.data.guestFlows = [];
  db.data.radcheck = {};
  db.data.radreply = {};
  db.data.radacct = [];
  db.data.leases = {};
});

// --- OTP saklama: hash + salt -----------------------------------------------

test('createGuestFlow OTP\'yi duz metin saklamaz, salt+sha256 hash saklar', () => {
  const flow = db.createGuestFlow('AA:BB:CC:DD:EE:01', '5551112233', '123456');

  assert.ok(!('otp' in flow), 'akista duz metin otp alani olmamali');
  assert.match(flow.salt, /^[0-9a-f]{16}$/, 'salt 8 bayt hex olmali');
  assert.match(flow.otpHash, /^[0-9a-f]{64}$/, 'hash sha256 hex olmali');
  assert.notStrictEqual(flow.otpHash, '123456');

  const expected = crypto.createHash('sha256')
    .update(flow.salt + ':' + '123456').digest('hex');
  assert.strictEqual(flow.otpHash, expected, 'hash sha256(salt + ":" + otp) olmali');

  // MAC normalize edildi mi?
  assert.strictEqual(flow.mac, 'aabbccddee01');
});

test('ayni OTP farkli akislarda farkli hash uretir (salt tekrar kullanilmiyor)', () => {
  const a = db.createGuestFlow('AA:BB:CC:DD:EE:01', '5551112233', '123456');
  const b = db.createGuestFlow('AA:BB:CC:DD:EE:02', '5554445566', '123456');

  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.otpHash, b.otpHash);
});

test('ayni MAC icin yeni akis, dogrulanmamis eski akisi temizler', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:01', '5551112233', '111111');
  db.createGuestFlow('AA:BB:CC:DD:EE:01', '5551112233', '222222');

  const flows = db.data.guestFlows.filter(f => f.mac === 'aabbccddee01');
  assert.strictEqual(flows.length, 1, 'bekleyen tek akis kalmali');
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:01', '111111').reason, 'bad_code');
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:01', '222222').ok, true);
});

// --- Yanlış deneme sayacı ve kilit (F-01) ------------------------------------

test('yanlis kod sayaci artar ve kalan hak dogru raporlanir', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:03', '5551112233', '123456');

  const first = db.verifyGuestFlow('AA:BB:CC:DD:EE:03', '000000');
  assert.deepStrictEqual(
    { ok: first.ok, reason: first.reason, remaining: first.remaining },
    { ok: false, reason: 'bad_code', remaining: MAX - 1 }
  );
  assert.strictEqual(db.data.guestFlows[0].attempts, 1);

  const second = db.verifyGuestFlow('AA:BB:CC:DD:EE:03', '000001');
  assert.strictEqual(second.remaining, MAX - 2);
  assert.strictEqual(db.data.guestFlows[0].attempts, 2);
});

test('son yanlis denemede akis kilitlenir ve dogru kod artik kabul edilmez', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:04', '5551112233', '123456');

  let last;
  for (let i = 0; i < MAX; i++) last = db.verifyGuestFlow('AA:BB:CC:DD:EE:04', '000000');

  assert.strictEqual(last.reason, 'locked');
  assert.strictEqual(last.remaining, 0);
  assert.ok(db.data.guestFlows[0].lockedAt, 'lockedAt damgalanmali');

  // Kilitten sonra DOĞRU kod bile geçmemeli — yeni OTP şart.
  const afterLock = db.verifyGuestFlow('AA:BB:CC:DD:EE:04', '123456');
  assert.strictEqual(afterLock.ok, false);
  assert.strictEqual(afterLock.reason, 'locked');
});

test('suresi gecmis akis expired dondurur, bilinmeyen MAC no_flow dondurur', () => {
  const flow = db.createGuestFlow('AA:BB:CC:DD:EE:05', '5551112233', '123456');
  flow.expiresAt = Date.now() - 1000;
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:05', '123456').reason, 'expired');

  assert.strictEqual(db.verifyGuestFlow('FF:FF:FF:FF:FF:FF', '123456').reason, 'no_flow');
});

// --- Sabit zamanlı karşılaştırma (safeEqualHex) ------------------------------

test('bozuk/farkli uzunluktaki hash timingSafeEqual\'i patlatmaz, bad_code doner', () => {
  const flow = db.createGuestFlow('AA:BB:CC:DD:EE:06', '5551112233', '123456');
  flow.otpHash = 'abc';   // gecersiz uzunluk — Buffer uzunluklari esit degil

  let res;
  assert.doesNotThrow(() => { res = db.verifyGuestFlow('AA:BB:CC:DD:EE:06', '123456'); });
  assert.strictEqual(res.reason, 'bad_code');
});

test('OTP sayi olarak verilse de dogrulanir (String donusumu)', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:07', '5551112233', '123456');
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:07', 123456).ok, true);
});

// --- Başarılı doğrulama: oturum sırrı ve RADIUS kayıtları (F-04) -------------

test('dogrulama basarili olunca rastgele oturum sirri uretilir (MAC parola DEGIL)', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:08', '5551112233', '123456');
  const res = db.verifyGuestFlow('AA:BB:CC:DD:EE:08', '123456');

  assert.strictEqual(res.ok, true);
  assert.match(res.sessionSecret, /^[0-9a-f]{32}$/, 'oturum sirri 16 bayt hex olmali');
  assert.notStrictEqual(res.sessionSecret, 'aabbccddee08', 'parola MAC olmamali');

  const check = db.getRadCheck('AA:BB:CC:DD:EE:08');
  assert.strictEqual(check.username, 'aabbccddee08');
  assert.strictEqual(check.password, res.sessionSecret);

  const reply = db.getRadReply('AA:BB:CC:DD:EE:08');
  assert.strictEqual(reply['Mikrotik-Rate-Limit'], config.session.rateLimit);
  assert.strictEqual(reply['Session-Timeout'], String(config.session.timeoutSeconds));
});

test('her akis icin farkli oturum sirri uretilir', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:09', '5551112233', '123456');
  db.createGuestFlow('AA:BB:CC:DD:EE:0A', '5554445566', '123456');

  const s1 = db.verifyGuestFlow('AA:BB:CC:DD:EE:09', '123456').sessionSecret;
  const s2 = db.verifyGuestFlow('AA:BB:CC:DD:EE:0A', '123456').sessionSecret;
  assert.notStrictEqual(s1, s2);
});

test('dogrulanmis akis tekrar dogrulanamaz (no_flow)', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:0B', '5551112233', '123456');
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:0B', '123456').ok, true);
  assert.strictEqual(db.verifyGuestFlow('AA:BB:CC:DD:EE:0B', '123456').reason, 'no_flow');
});

// --- DHCP kirası ve telefon çözümlemesi -------------------------------------

test('allocateIp ayni MAC icin ayni IP\'yi verir, farkli MAC\'e yeni IP', () => {
  const ip1 = db.allocateIp('AA:BB:CC:DD:EE:10');
  const ip2 = db.allocateIp('aa-bb-cc-dd-ee-10');   // ayni MAC, farkli bicim
  const ip3 = db.allocateIp('AA:BB:CC:DD:EE:11');

  assert.strictEqual(ip1, '192.168.20.100');
  assert.strictEqual(ip2, ip1, 'MAC normalize edilip ayni kira donmeli');
  assert.strictEqual(ip3, '192.168.20.101');
  assert.strictEqual(db.getMacByIp(ip1), 'aabbccddee10');
});

test('getPhoneByIp aktif oturumdan telefonu cozer, yoksa BILINMEYEN_TEL', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:12', '5559998877', '123456');
  db.verifyGuestFlow('AA:BB:CC:DD:EE:12', '123456');
  const ip = db.allocateIp('AA:BB:CC:DD:EE:12');
  db.startSession('sess-1', 'aabbccddee12', ip);

  assert.strictEqual(db.getPhoneByIp(ip), '5559998877');
  assert.strictEqual(db.getPhoneByMac('AA:BB:CC:DD:EE:12'), '5559998877');
  assert.strictEqual(db.getPhoneByIp('192.168.20.199'), 'BILINMEYEN_TEL');
});

test('startSession ayni kullanicinin eski oturumunu kapatir', () => {
  db.startSession('sess-a', 'aabbccddee13', '192.168.20.150');
  db.startSession('sess-b', 'aabbccddee13', '192.168.20.150');

  const sessions = db.data.radacct.filter(s => s.username === 'aabbccddee13');
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions[0].active, false, 'eski oturum kapatilmali');
  assert.strictEqual(sessions[1].active, true);
});

test('stopSession/updateSession bayt sayaclarini isler', () => {
  db.startSession('sess-c', 'aabbccddee14', '192.168.20.151');

  db.updateSession('sess-c', 1000, 2000);
  let s = db.data.radacct.find(x => x.sessionId === 'sess-c');
  assert.strictEqual(s.inputOctets, 1000);
  assert.strictEqual(s.active, true);

  db.stopSession('sess-c', 5000, 6000);
  s = db.data.radacct.find(x => x.sessionId === 'sess-c');
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.outputOctets, 6000);
  assert.ok(s.endTime, 'endTime damgalanmali');
});

// --- Saklama temizliği (F-07) ------------------------------------------------

test('purgeExpired eski dogrulanmamis akislari siler, dogrulanmislari korur', () => {
  const now = Date.now();
  const oldTs = now - 5 * 3600 * 1000;   // retention 1 saat -> bu eski

  db.data.guestFlows = [
    { id: 'x1', mac: 'aa0000000001', phone: '555', verified: false, expiresAt: oldTs },       // silinmeli
    { id: 'x2', mac: 'aa0000000002', phone: '555', verified: true,  expiresAt: oldTs },       // korunmali
    { id: 'x3', mac: 'aa0000000003', phone: '555', verified: false, expiresAt: now + 60000 }, // korunmali
  ];

  const removed = db.purgeExpired();

  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(db.data.guestFlows.map(f => f.id), ['x2', 'x3']);
});

test('purgeExpired saklama suresini asan kapali oturumlari siler, aktifleri korur', () => {
  const now = Date.now();
  const old = now - 3 * 86400 * 1000;   // retention 1 gun -> bu eski

  db.data.radacct = [
    { sessionId: 's1', username: 'a', startTime: old, endTime: old,  active: false },   // silinmeli
    { sessionId: 's2', username: 'b', startTime: old, endTime: null, active: true },    // korunmali (aktif)
    { sessionId: 's3', username: 'c', startTime: now, endTime: now,  active: false },   // korunmali (yeni)
  ];

  const removed = db.purgeExpired();

  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(db.data.radacct.map(s => s.sessionId), ['s2', 's3']);
});

test('purgeExpired silinecek kayit yoksa 0 doner', () => {
  db.data.guestFlows = [];
  db.data.radacct = [];
  assert.strictEqual(db.purgeExpired(), 0);
});
