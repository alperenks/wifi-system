/*
  =============================================================================
  Entegrasyon testi — Veri kotası + RFC 5176 Disconnect (B1 / F-10)
  =============================================================================
  Bu test SAHTE değil: gerçek UDP soketleri üzerinden gerçek RADIUS paketleri
  gider. Akış:

    yazılım NAS ──Access-Request──►  RADIUS sunucusu      (kimlik)
    yazılım NAS ──Accounting-Start►  RADIUS sunucusu      (oturum açılır)
    yazılım NAS ──Interim-Update──►  RADIUS sunucusu      (kota aşılır)
    yazılım NAS ◄─Disconnect-Req───  RADIUS sunucusu      (RFC 5176 CoA/DM)
    yazılım NAS ──Disconnect-ACK──►  RADIUS sunucusu      (kullanıcı düşürüldü)

  Standart portlar kullanılmaz (18120/18130/37990) — çalışan bir sunucuyla
  çakışmasın diye. db.json kum havuzuna alınır.
*/

const path = require('path');
const { sandboxJsonFile } = require('./_sandbox');

// 1) db.json'u kum havuzuna al — db.js yüklenirken bunu okuyacak.
sandboxJsonFile(path.join(__dirname, '..', 'db.json'), {
  guestFlows: [], radcheck: {}, radreply: {}, radacct: [], leases: {},
});

// 2) Test yapılandırması: düşük kota + çakışmayan portlar.
process.env.SIM_MODE = 'true';
process.env.QUOTA_MB = '2';
process.env.RADIUS_AUTH_PORT = '18120';
process.env.RADIUS_ACCT_PORT = '18130';
process.env.COA_PORT = '37990';
process.env.RADIUS_SECRET = 'test-radius-secret';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../config');
const db = require('../db');
const radiusServer = require('../radius-server');
const radiusClient = require('../radius-client');

const MB = 1024 * 1024;
let oturumSayaci = 0;

let servers;          // { authSocket, acctSocket }
let coaSocket;
const disconnects = [];               // NAS'ın düşürdüğü oturumlar
let disconnectBekleyen = null;        // sıradaki disconnect'i bekleyen resolver

test.before(async () => {
  servers = radiusServer.startRadiusServer();
  coaSocket = radiusClient.startCoaListener((info) => {
    disconnects.push(info);
    if (disconnectBekleyen) { disconnectBekleyen(info); disconnectBekleyen = null; }
  });
  // Soketlerin bağlanmasını bekle.
  await new Promise(r => setTimeout(r, 300));
});

test.after(() => {
  for (const s of [servers.authSocket, servers.acctSocket, coaSocket]) {
    try { s.close(); } catch (_) {}
  }
});

// Disconnect gelene kadar bekler (veya süre dolar).
function disconnectBekle(ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { disconnectBekleyen = null; resolve(null); }, ms);
    disconnectBekleyen = (info) => { clearTimeout(timer); resolve(info); };
  });
}

// Doğrulanmış bir misafir üretip RADIUS oturumunu açar.
async function misafirBagla(mac, phone) {
  db.createGuestFlow(mac, phone, '123456');
  const ip = db.allocateIp(mac);
  const vr = db.verifyGuestFlow(mac, '123456');
  assert.strictEqual(vr.ok, true, 'OTP dogrulanmaliydi');

  const auth = await radiusClient.authenticate(mac, vr.sessionSecret);
  assert.strictEqual(auth.accepted, true, 'Access-Accept beklenirdi');

  // Her bağlanışta benzersiz oturum kimliği (gerçek NAS de böyle yapar).
  const sessionId = 'test-' + mac.replace(/[^a-f0-9]/gi, '').slice(-6) + '-' + (++oturumSayaci);
  await radiusClient.accountingStart(mac, ip, sessionId);
  return { mac, ip, sessionId };
}

function oturum(sessionId) {
  return db.data.radacct.filter(s => s.sessionId === sessionId).pop();
}

// --- Testler -----------------------------------------------------------------

test('kota yapilandirmasi .env\'den okunuyor', () => {
  assert.strictEqual(config.quota.megabytes, 2);
  assert.strictEqual(config.quota.coaPort, 37990);
  assert.strictEqual(radiusServer.QUOTA_BYTES, 2 * MB);
});

test('kota altindaki interim-update oturumu ACIK birakir', async () => {
  const g = await misafirBagla('aa:bb:cc:00:00:01', '5551110001');
  assert.strictEqual(oturum(g.sessionId).active, true, 'oturum acilmis olmali');

  // 1 MB in + 0.2 MB out = 1.2 MB < 2 MB
  await radiusClient.accountingUpdate(g.mac, g.sessionId, 1 * MB, Math.round(0.2 * MB));
  await new Promise(r => setTimeout(r, 300));

  assert.strictEqual(oturum(g.sessionId).active, true, 'kota altinda oturum kapanmamali');
  assert.strictEqual(disconnects.length, 0, 'Disconnect gonderilmemeliydi');
});

test('kota asilinca oturum kapanir ve NAS Disconnect-Request alir', async () => {
  const g = await misafirBagla('aa:bb:cc:00:00:02', '5551110002');
  const bekle = disconnectBekle();

  // 2 MB in + 0.5 MB out = 2.5 MB > 2 MB
  await radiusClient.accountingUpdate(g.mac, g.sessionId, 2 * MB, Math.round(0.5 * MB));

  const info = await bekle;
  assert.ok(info, 'NAS bir Disconnect-Request almaliydi');
  assert.strictEqual(info.sessionId, g.sessionId);
  assert.strictEqual(info.ip, g.ip);

  const s = oturum(g.sessionId);
  assert.strictEqual(s.active, false, 'kota asilinca oturum kapanmali');
  assert.ok(s.endTime, 'oturum bitis zamani damgalanmali (5651 delili)');
  assert.strictEqual(s.inputOctets, 2 * MB, 'harcanan bayt kaydedilmeli');
});

test('kapanmis oturum icin ikinci kez Disconnect gonderilmez', async () => {
  const oncekiSayi = disconnects.length;
  const kapali = db.data.radacct.find(s => !s.active);

  await radiusClient.accountingUpdate(kapali.username, kapali.sessionId, 9 * MB, 9 * MB);
  await new Promise(r => setTimeout(r, 400));

  assert.strictEqual(disconnects.length, oncekiSayi, 'zaten kapali oturum tekrar dusurulmez');
});

test('NAS bilinmeyen oturum icin Disconnect-NAK doner', async () => {
  const sonuc = await radiusServer.sendDisconnect('aabbcc000099', 'boyle-bir-oturum-yok', '127.0.0.1');

  assert.strictEqual(sonuc.acked, false);
  assert.strictEqual(sonuc.code, 'Disconnect-NAK');
});

test('kota asan misafir yeniden dogrulanip bagalanabilir', async () => {
  const g = await misafirBagla('aa:bb:cc:00:00:03', '5551110003');
  const bekle = disconnectBekle();
  await radiusClient.accountingUpdate(g.mac, g.sessionId, 3 * MB, 0);
  assert.ok(await bekle, 'once dusurulmeli');

  // Aynı MAC yeni bir OTP akışıyla tekrar bağlanıyor.
  const g2 = await misafirBagla('aa:bb:cc:00:00:03', '5551110003');
  assert.strictEqual(oturum(g2.sessionId).active, true, 'yeni oturum acilabilmeli');
});
