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
const DB_JSON = path.join(__dirname, '..', 'db.json');
const dbFile = sandboxJsonFile(DB_JSON, {
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
process.env.DB_SAVE_DEBOUNCE_MS = '50';

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

// --- F1: Atomik yazma ve bozuk dosya koruması --------------------------------

test('save() once gecici dosyaya yazip yerine tasir (atomik)', () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:20', '5551234567', '123456');
  db.flush();

  // Geçici dosya arkada bırakılmamalı.
  assert.strictEqual(dbFile.rawGet(DB_JSON + '.tmp'), '', 'gecici dosya bosaltilmis olmali');

  // Asıl dosya geçerli JSON ve güncel veriyi içermeli.
  const kaydedilen = JSON.parse(dbFile.rawGet());
  assert.strictEqual(kaydedilen.guestFlows.at(-1).mac, 'aabbccddee20');
});

test("yarim kalmis yazma db.json dosyasini bozamaz (rename ile yer degistirme)", () => {
  db.createGuestFlow('AA:BB:CC:DD:EE:21', '5551234567', '123456');
  db.flush();
  const saglamIcerik = dbFile.rawGet();

  // Yazma sırasında süreç ölmüş gibi: geçici dosya yarım, asıl dosya el değmemiş.
  dbFile.rawSet('{"guestFlows": [ YARIM', DB_JSON + '.tmp');

  assert.strictEqual(dbFile.rawGet(), saglamIcerik, 'asil dosya bozulmamali');
  assert.doesNotThrow(() => JSON.parse(dbFile.rawGet()));
});

test('bozuk db.json UZERINE YAZILMAZ, kenara alinir (delil kaybi olmaz)', () => {
  const bozukIcerik = '{"guestFlows": [{"id":"kurtarilacak-kayit"';
  dbFile.rawSet(bozukIcerik);

  const oncekiBozukSayisi = dbFile.rawKeys().filter(k => k.includes('.bozuk-')).length;
  db.load();   // parse patlamali -> karantina
  const bozukDosyalar = dbFile.rawKeys().filter(k => k.includes('.bozuk-'));

  assert.strictEqual(bozukDosyalar.length, oncekiBozukSayisi + 1, 'bozuk dosya kenara alinmali');
  assert.strictEqual(dbFile.rawGet(bozukDosyalar.at(-1)), bozukIcerik,
    'kenara alinan dosya orijinal icerigi korumali');

  // Sonraki yazma temiz bir db.json uretir; karantinadaki dosyaya dokunmaz.
  db.data.guestFlows = [];
  db.flush();
  assert.doesNotThrow(() => JSON.parse(dbFile.rawGet()));
  assert.strictEqual(dbFile.rawGet(bozukDosyalar.at(-1)), bozukIcerik);
});

// --- F2: Yazma biriktirme -----------------------------------------------------

const uyu = (ms) => new Promise(r => setTimeout(r, ms));

test('ardisik save() cagrilari tek diske yazmaya toplanir', async () => {
  db.flush();                       // bekleyen yazma kalmasin
  const oncekiYazma = db.writeCount;

  for (let i = 0; i < 10; i++) {
    db.createGuestFlow(`AA:BB:CC:DD:F0:${i.toString(16).padStart(2, '0')}`, '5551112233', '123456');
  }
  assert.strictEqual(db.writeCount, oncekiYazma, 'pencere dolmadan diske yazilmamali');

  await uyu(120);                   // DB_SAVE_DEBOUNCE_MS = 50
  assert.strictEqual(db.writeCount, oncekiYazma + 1, '10 degisiklik icin tek yazma yeterli');

  // Veri gerçekten diskte mi?
  const kaydedilen = JSON.parse(dbFile.rawGet());
  assert.strictEqual(kaydedilen.guestFlows.length, 10);
});

test('flush() bekletmeden hemen yazar', () => {
  db.createGuestFlow('AA:BB:CC:DD:F1:01', '5551112233', '123456');
  const oncekiYazma = db.writeCount;

  db.flush();

  assert.strictEqual(db.writeCount, oncekiYazma + 1);
  assert.strictEqual(JSON.parse(dbFile.rawGet()).guestFlows.at(-1).mac, 'aabbccddf101');
});

test('flushIfPending yalnizca bekleyen yazma varsa diske dokunur', () => {
  db.flush();
  const oncekiYazma = db.writeCount;

  db.flushIfPending();              // bekleyen yok -> yazma olmamali
  assert.strictEqual(db.writeCount, oncekiYazma);

  db.createGuestFlow('AA:BB:CC:DD:F2:01', '5551112233', '123456');
  db.flushIfPending();              // bekleyen var -> yazmali
  assert.strictEqual(db.writeCount, oncekiYazma + 1);
});

test('biriktirme veri kaybetmez: son durum diske yansir', async () => {
  db.data.guestFlows = [];
  db.flush();

  db.createGuestFlow('AA:BB:CC:DD:F3:01', '5551112233', '123456');
  db.allocateIp('AA:BB:CC:DD:F3:01');
  db.verifyGuestFlow('AA:BB:CC:DD:F3:01', '123456');
  await uyu(120);

  const kaydedilen = JSON.parse(dbFile.rawGet());
  assert.strictEqual(kaydedilen.guestFlows.at(-1).verified, true, 'son durum diske yazilmali');
  assert.ok(kaydedilen.radcheck['aabbccddf301'], 'RADIUS kaydi da diskte olmali');
});

// --- G2: Suresi dolan oturumlarin kapatilmasi --------------------------------

test('expireStaleSessions suresi dolan oturumlari kapatir, yenileri birakir', () => {
  const now = Date.now();
  const omurMs = 7200 * 1000;                    // Session-Timeout = 2 saat

  db.data.radacct = [
    { sessionId: 'eski',  username: 'a', ip: '192.168.20.100', startTime: now - 3 * 3600 * 1000, endTime: null, active: true },
    { sessionId: 'taze',  username: 'b', ip: '192.168.20.101', startTime: now - 600 * 1000,      endTime: null, active: true },
    { sessionId: 'kapali', username: 'c', ip: '192.168.20.102', startTime: now - 5 * 3600 * 1000, endTime: now - 4 * 3600 * 1000, active: false },
  ];

  const kapatilan = db.expireStaleSessions(omurMs);

  assert.strictEqual(kapatilan, 1);
  const eski = db.data.radacct.find(s2 => s2.sessionId === 'eski');
  assert.strictEqual(eski.active, false);
  assert.strictEqual(eski.terminateCause, 'timeout');
  assert.strictEqual(eski.endTime, eski.startTime + omurMs,
    'bitis zamani, fark edilen an degil surenin doldugu an olmali');

  assert.strictEqual(db.data.radacct.find(s2 => s2.sessionId === 'taze').active, true);
});

test('expireStaleSessions kapatilacak oturum yoksa 0 doner ve tekrar cagrilabilir', () => {
  const now = Date.now();
  db.data.radacct = [
    { sessionId: 'taze', username: 'a', ip: '192.168.20.100', startTime: now, endTime: null, active: true },
  ];

  assert.strictEqual(db.expireStaleSessions(7200 * 1000), 0);
  assert.strictEqual(db.expireStaleSessions(7200 * 1000), 0, 'ikinci cagri da sorunsuz olmali');
});

test('expireStaleSessions gecersiz sure degerinde hicbir seyi kapatmaz', () => {
  db.data.radacct = [
    { sessionId: 'eski', username: 'a', ip: '192.168.20.100', startTime: 0, endTime: null, active: true },
  ];

  for (const gecersiz of [0, -1, NaN, undefined, null, 'iki saat']) {
    assert.strictEqual(db.expireStaleSessions(gecersiz), 0, `gecersiz: ${String(gecersiz)}`);
  }
  assert.strictEqual(db.data.radacct[0].active, true, 'oturum el degmemis kalmali');
});

test('kota ile kapanan oturum, sure dolmasi ile kapananla karismaz', () => {
  const now = Date.now();
  db.data.radacct = [
    { sessionId: 'kota', username: 'a', ip: '192.168.20.100', startTime: now - 5 * 3600 * 1000,
      endTime: now - 4 * 3600 * 1000, active: false, terminateCause: 'quota' },
    { sessionId: 'sure', username: 'b', ip: '192.168.20.101', startTime: now - 5 * 3600 * 1000,
      endTime: null, active: true },
  ];

  db.expireStaleSessions(7200 * 1000);

  assert.strictEqual(db.data.radacct[0].terminateCause, 'quota', 'kota sebebi korunmali');
  assert.strictEqual(db.data.radacct[1].terminateCause, 'timeout');
});

// --- I1: Kira havuzu tukendiginde ne oluyor? ---------------------------------

test('havuz dolunca aktif oturumu OLMAYAN kira geri alinir', () => {
  // Havuz testte 100-102 (3 adres)
  const a = db.allocateIp('aa:00:00:00:00:01');
  const b = db.allocateIp('aa:00:00:00:00:02');
  const c = db.allocateIp('aa:00:00:00:00:03');
  assert.deepStrictEqual([a, b, c], ['192.168.20.100', '192.168.20.101', '192.168.20.102']);

  // Yalnizca ilk iki adres aktif oturumda; ucuncusu bos.
  db.startSession('s-a', 'aa0000000001', a);
  db.startSession('s-b', 'aa0000000002', b);

  const yeni = db.allocateIp('aa:00:00:00:00:04');

  assert.strictEqual(yeni, c, 'bos duran kira geri alinip yeni cihaza verilmeli');
  assert.strictEqual(db.data.leases['aa0000000003'], undefined, 'eski kira dusurulmeli');
  assert.strictEqual(db.data.leases['aa0000000004'], c);
});

test('aktif oturumdaki kiralar geri alinmaz', () => {
  const a = db.allocateIp('aa:00:00:00:00:01');
  const b = db.allocateIp('aa:00:00:00:00:02');
  const c = db.allocateIp('aa:00:00:00:00:03');
  db.startSession('s-a', 'aa0000000001', a);
  db.startSession('s-b', 'aa0000000002', b);
  db.startSession('s-c', 'aa0000000003', c);

  const yeni = db.allocateIp('aa:00:00:00:00:05');

  // Hepsi kullanimda: eski davranisa dusulur ama kiralar korunur.
  assert.strictEqual(db.data.leases['aa0000000001'], a);
  assert.strictEqual(db.data.leases['aa0000000002'], b);
  assert.strictEqual(db.data.leases['aa0000000003'], c);
  assert.strictEqual(yeni, '192.168.20.100', 'kapasite asiminda ilk adres paylasilir');
});

test('ayni IP birden fazla aktif oturumda ise EN SON oturumun telefonu doner', () => {
  const ip = '192.168.20.100';

  db.createGuestFlow('aa:00:00:00:00:01', '5551110001', '123456');
  db.verifyGuestFlow('aa:00:00:00:00:01', '123456');
  db.createGuestFlow('aa:00:00:00:00:02', '5552220002', '123456');
  db.verifyGuestFlow('aa:00:00:00:00:02', '123456');

  // Iki oturum ayni IP'de aktif (havuz tukenmis senaryosu)
  db.data.radacct.push(
    { sessionId: 'eski', username: 'aa0000000001', ip, startTime: Date.now() - 60000, endTime: null, active: true },
    { sessionId: 'yeni', username: 'aa0000000002', ip, startTime: Date.now(), endTime: null, active: true },
  );

  assert.strictEqual(db.getPhoneByIp(ip), '5552220002', 'en son oturumun telefonu esas alinmali');
});

// --- Kimlik çözümlemenin tutarlılığı (güvenlik/kod incelemesi bulgusu) --------

test("ayni IP'de iki aktif oturum varsa MAC ve TELEFON ayni misafire ait olur", () => {
  const IP = '192.168.20.100';

  for (const [mac, tel] of [['aa0000000001', '5551110001'], ['aa0000000002', '5552220002']]) {
    db.data.guestFlows.push({ id: mac, mac, phone: tel, verified: true, verifiedAt: Date.now(), expiresAt: Date.now() + 60000 });
    db.data.leases[mac] = IP;
    db.data.radacct.push({ sessionId: 's-' + mac, username: mac, ip: IP, startTime: Date.now(), endTime: null, active: true });
  }

  // Iki yarim ayni oturumu gormeli: aksi halde tek log satirinda iki kisi olur.
  assert.strictEqual(db.macByIp(IP), 'aa0000000002', "en son oturumun MAC adresi");
  assert.strictEqual(db.getPhoneByIp(IP), '5552220002', 'ayni oturumun telefonu');
  assert.strictEqual(db.getPhoneByMac(db.macByIp(IP)), db.getPhoneByIp(IP),
    'MAC uzerinden ve IP uzerinden ayni numara cikmali');
});

test('ayni MAC yeni numarayla dogrulanirsa GUNCEL numara doner', () => {
  db.data.guestFlows.push(
    { id: 'x1', mac: 'bb0000000001', phone: '5550000001', verified: true, verifiedAt: 1, expiresAt: 9e15 },
    { id: 'x2', mac: 'bb0000000001', phone: '5559999999', verified: true, verifiedAt: 2, expiresAt: 9e15 },
  );
  db.data.radacct.push({ sessionId: 's2', username: 'bb0000000001', ip: '192.168.20.150',
    startTime: Date.now(), endTime: null, active: true });

  assert.strictEqual(db.getPhoneByIp('192.168.20.150'), '5559999999');
  assert.strictEqual(db.getPhoneByMac('bb0000000001'), '5559999999');
});

test('aktif oturum yoksa MAC DHCP kirasindan cozulur', () => {
  db.data.leases['cc0000000001'] = '192.168.20.160';
  db.data.guestFlows.push({ id: 'y1', mac: 'cc0000000001', phone: '5557778899',
    verified: true, verifiedAt: Date.now(), expiresAt: 9e15 });

  assert.strictEqual(db.macByIp('192.168.20.160'), 'cc0000000001');
  assert.strictEqual(db.getPhoneByIp('192.168.20.160'), '5557778899');
  assert.strictEqual(db.macByIp('192.168.20.199'), null, 'bilinmeyen IP null');
});

test('db.js sureci kapatma sinyallerini GASP ETMEZ', () => {
  // Veri modulu SIGINT/SIGTERM dinlememeli: soketlerin sahibi server.js.
  assert.strictEqual(process.listenerCount('SIGINT'), 0, 'db.js SIGINT dinlememeli');
  assert.strictEqual(process.listenerCount('SIGTERM'), 0, 'db.js SIGTERM dinlememeli');
  assert.ok(process.listenerCount('exit') >= 1, 'exit kancasi ise KALMALI (bekleyen yazma)');
});
