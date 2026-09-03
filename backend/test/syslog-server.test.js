/*
  =============================================================================
  Birim testleri — syslog-server.js  (G1)
  =============================================================================
  Bu ayrıştırıcı 5651 delilinin KAYNAĞIDIR: pfSense'ten gelen ham satırı
  "kim, ne zaman, nereye bağlandı" kaydına çeviren yer burasıdır. Yanlış
  ayrıştırma = eksik/yanlış delil.

  Kapsam:
    - pfSense unbound (DNS) ve filterlog (NAT) biçimleri
    - MikroTik firewall biçimi ve MOCK_* simülasyon biçimleri
    - kaydedilmemesi GEREKEN satırlar (block, IPv6, dış kaynak, bozuk girdi)
    - IP → telefon / MAC çözümlemesi
    - 5651 log satırı biçiminin birebir korunması (yasal biçim)

  ÖNEMLİ: ne db.json'a ne de logs/ dizinine dokunulur (kum havuzu).
*/

const path = require('path');
const { sandboxJsonFile, sandboxDir } = require('./_sandbox');

// 1) Hem veritabanı hem log dizini kum havuzunda.
sandboxJsonFile(path.join(__dirname, '..', 'db.json'), {
  guestFlows: [], radcheck: {}, radreply: {}, radacct: [], leases: {},
});
const sandbox = sandboxDir(path.join(__dirname, '..', 'logs', '5651_captive'));

process.env.SIM_MODE = 'true';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const { parseSyslogLine, buildLogLine } = require('../syslog-server');

test.after(() => sandbox.cleanup());

// Doğrulanmış bir misafir + aktif oturum kurar.
function misafirKur(mac, ip, phone) {
  const temizMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  db.data.guestFlows.push({
    id: temizMac, mac: temizMac, phone, verified: true, verifiedAt: Date.now(), expiresAt: Date.now() + 60000,
  });
  db.data.leases[temizMac] = ip;
  db.data.radacct.push({
    sessionId: 'sess-' + temizMac, username: temizMac, ip,
    startTime: Date.now(), endTime: null, inputOctets: 0, outputOctets: 0, active: true,
  });
  return temizMac;
}

test.beforeEach(() => {
  db.data.guestFlows = [];
  db.data.radcheck = {};
  db.data.radreply = {};
  db.data.radacct = [];
  db.data.leases = {};
});

// --- pfSense unbound (DNS) ---------------------------------------------------

test('unbound DNS satiri DNS kaydina cevrilir', () => {
  misafirKur('aa:bb:cc:dd:ee:01', '192.168.20.15', '5551112233');

  const ham = '<13>Sep  3 05:32:10 pfSense unbound[90243]: info: 192.168.20.15 www.google.com. A IN';
  const kayit = parseSyslogLine(ham);

  assert.ok(kayit, 'kayit uretilmeliydi');
  assert.strictEqual(kayit.type, 'DNS');
  assert.strictEqual(kayit.localIp, '192.168.20.15');
  assert.strictEqual(kayit.destIp, 'DNS_RESOLVER');
  assert.strictEqual(kayit.destPort, 53);
  assert.strictEqual(kayit.details, 'DNS_Query: www.google.com');
  assert.strictEqual(kayit.phone, '5551112233', 'telefon numarasi cozulmeli');
  assert.strictEqual(kayit.mac, 'aabbccddee01');
  assert.match(kayit.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('alt alan adlari ve tireli adlar da yakalanir', () => {
  misafirKur('aa:bb:cc:dd:ee:02', '192.168.20.16', '5551112233');

  const kayit = parseSyslogLine('<13>Sep  3 05:32:10 unbound[1]: info: 192.168.20.16 cdn-static.example-site.com. AAAA IN');
  assert.ok(kayit);
  assert.strictEqual(kayit.details, 'DNS_Query: cdn-static.example-site.com');
});

test('bozuk unbound satiri kayit uretmez', () => {
  assert.strictEqual(parseSyslogLine('<13>Sep  3 unbound[1]: info: eksik-alanlar'), null);
  assert.strictEqual(parseSyslogLine('unbound'), null);
});

// --- pfSense filterlog (NAT) -------------------------------------------------

const FILTERLOG_PASS =
  '<134>Sep  3 05:33:00 pfSense filterlog: 5,,,1000000103,em1,match,pass,out,4,0x0,,64,0,0,DF,6,tcp,60,' +
  '192.168.20.15,142.250.187.68,51234,443,0,S';

test('filterlog pass satiri NAT kaydina cevrilir', () => {
  misafirKur('aa:bb:cc:dd:ee:03', '192.168.20.15', '5559998877');

  const kayit = parseSyslogLine(FILTERLOG_PASS);

  assert.ok(kayit);
  assert.strictEqual(kayit.type, 'NAT');
  assert.strictEqual(kayit.localIp, '192.168.20.15');
  assert.strictEqual(kayit.destIp, '142.250.187.68');
  assert.strictEqual(kayit.srcPort, 51234);
  assert.strictEqual(kayit.destPort, 443);
  assert.strictEqual(kayit.details, 'Proto: TCP', 'protokol buyuk harfe cevrilmeli');
  assert.strictEqual(kayit.phone, '5559998877');
  assert.strictEqual(kayit.mac, 'aabbccddee03');
});

test('engellenen (block) trafik 5651 loguna yazilmaz', () => {
  misafirKur('aa:bb:cc:dd:ee:04', '192.168.20.15', '5551112233');
  const engellenen = FILTERLOG_PASS.replace(',match,pass,out,', ',match,block,out,');

  assert.strictEqual(parseSyslogLine(engellenen), null);
});

test('IPv6 filterlog satiri (henuz) kaydedilmez', () => {
  misafirKur('aa:bb:cc:dd:ee:05', '192.168.20.15', '5551112233');
  const ipv6 = FILTERLOG_PASS.replace(',pass,out,4,', ',pass,out,6,');

  assert.strictEqual(parseSyslogLine(ipv6), null);
});

test('misafir agindan gelmeyen kaynak IP kaydedilmez', () => {
  const disKaynak = FILTERLOG_PASS.replace('192.168.20.15,', '8.8.8.8,');
  assert.strictEqual(parseSyslogLine(disKaynak), null);
});

test('eksik alanli filterlog satiri cokme yapmadan null doner', () => {
  const kisa = '<134>Sep  3 05:33:00 pfSense filterlog: 5,,,1000,em1,match,pass,out,4';

  let sonuc;
  assert.doesNotThrow(() => { sonuc = parseSyslogLine(kisa); });
  assert.strictEqual(sonuc, null);
});

test('10.x ve 172.x misafir aglari da kabul edilir', () => {
  for (const ip of ['10.0.0.5', '172.16.4.9']) {
    const satir = FILTERLOG_PASS.replace('192.168.20.15,', ip + ',');
    const kayit = parseSyslogLine(satir);
    assert.ok(kayit, `${ip} kaydedilmeliydi`);
    assert.strictEqual(kayit.localIp, ip);
  }
});

// --- MikroTik ----------------------------------------------------------------

test('MikroTik firewall satiri MAC ve baglanti bilgisini cozer', () => {
  misafirKur('00:11:22:33:44:55', '192.168.88.254', '5443332211');

  const ham = 'firewall,info forward: in:bridge-guest out:ether1-wan, src-mac 00:11:22:33:44:55, ' +
    'proto TCP (SYN), 192.168.88.254:50123->142.250.185.78:443, len 60';
  const kayit = parseSyslogLine(ham);

  assert.ok(kayit);
  assert.strictEqual(kayit.type, 'NAT');
  assert.strictEqual(kayit.mac, '001122334455', 'MAC normalize edilmeli');
  assert.strictEqual(kayit.localIp, '192.168.88.254');
  assert.strictEqual(kayit.destIp, '142.250.185.78');
  assert.strictEqual(kayit.destPort, 443);
  assert.strictEqual(kayit.phone, '5443332211');
  assert.strictEqual(kayit.details, 'MikroTik Firewall Event');
});

// --- Simülasyon (MOCK_*) -----------------------------------------------------

test('MOCK_LOG satiri NAT kaydi uretir', () => {
  misafirKur('aa:bb:cc:dd:ee:06', '192.168.20.20', '5321112233');

  const kayit = parseSyslogLine('MOCK_LOG: localIp=192.168.20.20 destIp=1.1.1.1 destPort=443 srcPort=40000 proto=UDP');

  assert.ok(kayit);
  assert.strictEqual(kayit.type, 'NAT');
  assert.strictEqual(kayit.destPort, 443);
  assert.strictEqual(kayit.srcPort, 40000);
  assert.strictEqual(kayit.details, 'Simulated connection proto: UDP');
  assert.strictEqual(kayit.phone, '5321112233');
});

test('MOCK_DNS satiri DNS kaydi uretir', () => {
  misafirKur('aa:bb:cc:dd:ee:07', '192.168.20.21', '5321112233');

  const kayit = parseSyslogLine('MOCK_DNS: localIp=192.168.20.21 domain=youtube.com');

  assert.ok(kayit);
  assert.strictEqual(kayit.type, 'DNS');
  assert.strictEqual(kayit.destPort, 53);
  assert.strictEqual(kayit.details, 'Simulated DNS: youtube.com');
});

// --- Tanınmayan / bozuk girdi ------------------------------------------------

test('taninmayan satirlar cokme yapmadan null doner', () => {
  const girdiler = [
    '', '   ', 'rastgele metin', '<13>Sep  3 05:00:00 pfSense sshd[1]: Accepted publickey',
    'MOCK_', 'filterlog', null, undefined, 12345, {}, [],
  ];

  for (const g of girdiler) {
    let sonuc;
    assert.doesNotThrow(() => { sonuc = parseSyslogLine(g); }, `cokmemeli: ${String(g)}`);
    assert.strictEqual(sonuc, null, `null donmeliydi: ${String(g)}`);
  }
});

// --- Kimlik çözümleme --------------------------------------------------------

test('oturumu olmayan IP icin BILINMEYEN_TEL ve UNKNOWN_MAC yazilir', () => {
  const kayit = parseSyslogLine(FILTERLOG_PASS);   // 192.168.20.15 icin kayit yok

  assert.ok(kayit, 'kayit yine de uretilmeli — delil kaybolmamali');
  assert.strictEqual(kayit.phone, 'BILINMEYEN_TEL');
  assert.strictEqual(kayit.mac, 'UNKNOWN_MAC');
});

test('oturum kapandiysa MAC DHCP kirasindan cozulur', () => {
  const mac = misafirKur('aa:bb:cc:dd:ee:08', '192.168.20.15', '5551112233');
  db.data.radacct[0].active = false;              // oturum kapandi, kira duruyor

  const kayit = parseSyslogLine(FILTERLOG_PASS);

  assert.strictEqual(kayit.mac, mac, 'kiradan cozulmeli');
  assert.strictEqual(kayit.phone, '5551112233', 'dogrulanmis akistan telefon cozulmeli');
});

// --- 5651 log satırı biçimi (YASAL BİÇİM — değişmemeli) ----------------------

test('5651 log satiri biciminin alanlari ve sirasi sabittir', () => {
  const kayit = {
    timestamp: '2026-09-03T05:33:00.000Z',
    type: 'NAT',
    mac: 'aabbccddee01',
    localIp: '192.168.20.15',
    srcPort: 51234,
    destIp: '142.250.187.68',
    destPort: 443,
    phone: '5551112233',
    details: 'Proto: TCP',
  };

  assert.strictEqual(
    buildLogLine(kayit),
    '2026-09-03T05:33:00.000Z | NAT | aabbccddee01 | 192.168.20.15 | 51234 | 142.250.187.68 | 443 | 5551112233 | Proto: TCP\n'
  );
});

test('kaynak port yoksa N/A yazilir ve satir yine 9 alanlidir', () => {
  const satir = buildLogLine({
    timestamp: '2026-09-03T05:33:00.000Z',
    type: 'DNS',
    mac: 'aabbccddee01',
    localIp: '192.168.20.15',
    destIp: 'DNS_RESOLVER',
    destPort: 53,
    phone: '5551112233',
    details: 'DNS_Query: www.google.com',
  });

  assert.ok(satir.endsWith('\n'), 'satir yeni satirla bitmeli');
  const alanlar = satir.trimEnd().split(' | ');
  assert.strictEqual(alanlar.length, 9, '5651 satiri 9 alanli olmali');
  assert.strictEqual(alanlar[4], 'N/A');
});

test('ayristirilan kayit dogrudan log satirina cevrilebilir (uctan uca)', () => {
  misafirKur('aa:bb:cc:dd:ee:09', '192.168.20.15', '5551112233');

  const satir = buildLogLine(parseSyslogLine(FILTERLOG_PASS));
  const alanlar = satir.trimEnd().split(' | ');

  assert.strictEqual(alanlar.length, 9);
  assert.strictEqual(alanlar[1], 'NAT');
  assert.strictEqual(alanlar[2], 'aabbccddee09');
  assert.strictEqual(alanlar[7], '5551112233');
});
