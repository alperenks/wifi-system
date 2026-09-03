/*
  =============================================================================
  Birim testleri — kamusm-signer.js + verify-chain.js  (A3)
  =============================================================================
  Kapsam (F-08): günlük log → gz + SHA-256 + zincirli damga; zincirin
  bozulduğu üç senaryonun YAKALANMASI:
    - araya gün ekleme (previousHash artık uyuşmuyor)
    - gün silme (zincir kopuyor)
    - içerik değiştirme (.log.gz hash'i damgayla uyuşmuyor)

  ÖNEMLİ: gerçek `backend/logs/5651_captive` dizinine dokunulmaz — _sandbox.js
  ile tüm dizin geçici bir klasöre yönlendirilir (require'dan ÖNCE).
*/

const path = require('path');
const os = require('os');
const { sandboxDir } = require('./_sandbox');

// 1) Log dizinini kum havuzuna al — signer ve verifier oraya yazacak/okuyacak.
const sandbox = sandboxDir(path.join(__dirname, '..', 'logs', '5651_captive'));

// 2) Deterministik yapılandırma (dotenv mevcut process.env'i EZMEZ).
process.env.SIM_MODE = 'true';
process.env.RETENTION_LOG_DAYS = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const signer = require('../kamusm-signer');
const { verifyChain } = require('../verify-chain');

const { LOGS_DIR, GENESIS } = signer;

// --- Yardımcılar -------------------------------------------------------------

// Kum havuzundaki gerçek (geçici) dizini temizler.
function clearSandbox() {
  for (const f of fs.readdirSync(sandbox.dir)) {
    fs.unlinkSync(path.join(sandbox.dir, f));
  }
}

// Verilen tarih için sahte bir 5651 log dosyası yazar (biçim üretimdekiyle aynı).
function writeLog(dateStr, satirSayisi = 3) {
  const lines = [];
  for (let i = 0; i < satirSayisi; i++) {
    lines.push(`${dateStr}T10:0${i}:00.000Z|192.168.20.10${i}|5551112233|example.com|ACCEPT`);
  }
  fs.writeFileSync(path.join(LOGS_DIR, `${dateStr}.log`), lines.join('\n') + '\n', 'utf8');
}

function readTs(dateStr) {
  return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, `${dateStr}.ts`), 'utf8'));
}

function gunOnce(gun) {
  return new Date(Date.now() - gun * 86400000).toISOString().slice(0, 10);
}

test.beforeEach(() => clearSandbox());
test.after(() => sandbox.cleanup());

// --- Tekil imzalama ----------------------------------------------------------

test('kum havuzu gercek log dizinine yonlendirmiyor (guvenlik kontrolu)', () => {
  assert.ok(sandbox.dir.startsWith(os.tmpdir()), 'gecici dizin kullanilmali');
  assert.ok(!path.resolve(LOGS_DIR).startsWith(os.tmpdir()), 'LOGS_DIR gercek yol olmali');

  writeLog('2026-01-01');
  // Yazma gerçekten geçici dizine düştü mü?
  assert.ok(fs.readdirSync(sandbox.dir).includes('2026-01-01.log'));
});

test('signDailyLog gz + sha256 + zincirli damga uretir', () => {
  writeLog('2026-01-01');
  const ts = signer.signDailyLog('2026-01-01');

  assert.ok(ts, 'damga nesnesi donmeli');
  assert.strictEqual(ts.mock, true, 'simulasyonda mock isaretli olmali');
  assert.strictEqual(ts.hashAlgorithm, 'SHA-256');
  assert.strictEqual(ts.previousHash, GENESIS, 'ilk gun GENESIS\'e baglanmali');

  // .log.gz gercekten uretildi ve icerigi .log ile ayni mi?
  const gzPath = path.join(LOGS_DIR, '2026-01-01.log.gz');
  assert.ok(fs.existsSync(gzPath));
  const gzData = fs.readFileSync(gzPath);
  const acilan = zlib.gunzipSync(gzData).toString('utf8');
  assert.strictEqual(acilan, fs.readFileSync(path.join(LOGS_DIR, '2026-01-01.log'), 'utf8'));

  // hashedMessage = sha256(.log.gz)
  const beklenenHash = crypto.createHash('sha256').update(gzData).digest('hex');
  assert.strictEqual(ts.hashedMessage, beklenenHash);

  // chainHash = sha256(previousHash + hashedMessage + productionTime)
  const beklenenChain = crypto.createHash('sha256')
    .update(ts.previousHash + ts.hashedMessage + ts.productionTime).digest('hex');
  assert.strictEqual(ts.chainHash, beklenenChain);

  // chain.json indeksi guncellendi mi?
  const chain = JSON.parse(fs.readFileSync(signer.CHAIN_PATH, 'utf8'));
  assert.strictEqual(chain['2026-01-01'].chainHash, ts.chainHash);
});

test('log dosyasi yoksa signDailyLog false doner (cokmez)', () => {
  assert.strictEqual(signer.signDailyLog('2026-01-01'), false);
  assert.ok(!fs.existsSync(path.join(LOGS_DIR, '2026-01-01.ts')));
});

// --- Zincir: geçerli durum ---------------------------------------------------

test('ardisik gunler zincire baglanir ve dogrulama gecer', () => {
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    writeLog(d);
    signer.signDailyLog(d);
  }

  const t1 = readTs('2026-01-01');
  const t2 = readTs('2026-01-02');
  const t3 = readTs('2026-01-03');

  assert.strictEqual(t1.previousHash, GENESIS);
  assert.strictEqual(t2.previousHash, t1.chainHash, '2. gun 1. gune baglanmali');
  assert.strictEqual(t3.previousHash, t2.chainHash, '3. gun 2. gune baglanmali');

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, true, sonuc.error);
  assert.strictEqual(sonuc.verified, 3);
});

// --- Zincir: bozulma senaryoları ---------------------------------------------

test('aradan bir gun silinirse zincir KOPUK olarak yakalanir', () => {
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    writeLog(d);
    signer.signDailyLog(d);
  }

  // Ortadaki gunun delilini yok et.
  fs.unlinkSync(path.join(LOGS_DIR, '2026-01-02.ts'));
  fs.unlinkSync(path.join(LOGS_DIR, '2026-01-02.log.gz'));

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false);
  assert.match(sonuc.error, /ZINCIR KOPUK/);
  assert.match(sonuc.error, /2026-01-03/, 'kopmanin hangi gunde oldugu bildirilmeli');
  assert.strictEqual(sonuc.verified, 1, 'kopmadan onceki gunler dogrulanmis sayilir');
});

test('sonradan araya gun eklenirse zincir kopar', () => {
  writeLog('2026-01-01'); signer.signDailyLog('2026-01-01');
  writeLog('2026-01-03'); signer.signDailyLog('2026-01-03');
  assert.strictEqual(verifyChain(sandbox.dir).ok, true, 'once gecerli olmali');

  // Geriye donuk olarak araya bir gun sokusturuluyor.
  writeLog('2026-01-02'); signer.signDailyLog('2026-01-02');

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false, 'araya gun eklemek zinciri kirmali');
  assert.match(sonuc.error, /ZINCIR KOPUK/);
  assert.match(sonuc.error, /2026-01-03/);
});

test('log icerigi degistirilirse damga uyusmazligi yakalanir', () => {
  writeLog('2026-01-01'); signer.signDailyLog('2026-01-01');

  // .log.gz'yi kurcala — icerik degisti.
  const gzPath = path.join(LOGS_DIR, '2026-01-01.log.gz');
  fs.writeFileSync(gzPath, zlib.gzipSync('SAHTE KAYIT: hicbir misafir yoktu\n'));

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false);
  assert.match(sonuc.error, /icerik DEGISTIRILMIS/);
});

test('damga alanlari kurcalanirsa chainHash tutarsizligi yakalanir', () => {
  writeLog('2026-01-01'); signer.signDailyLog('2026-01-01');

  const tsPath = path.join(LOGS_DIR, '2026-01-01.ts');
  const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
  ts.productionTime = '2020-01-01T00:00:00.000Z';   // zamani geriye al
  fs.writeFileSync(tsPath, JSON.stringify(ts, null, 2), 'utf8');

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false);
  assert.match(sonuc.error, /chainHash tutarsiz/);
});

test('.log.gz silinirse eksik icerik olarak raporlanir', () => {
  writeLog('2026-01-01'); signer.signDailyLog('2026-01-01');
  fs.unlinkSync(path.join(LOGS_DIR, '2026-01-01.log.gz'));

  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false);
  assert.match(sonuc.error, /\.log\.gz dosyasi eksik/);
});

test('hic damga yoksa dogrulama basarisiz olur', () => {
  const sonuc = verifyChain(sandbox.dir);
  assert.strictEqual(sonuc.ok, false);
  assert.match(sonuc.error, /Hic damga/);
});

// --- Saklama temizliği (F-07) ------------------------------------------------

test('purgeOldLogs saklama suresini asan uculuyu siler, yenisini korur', () => {
  const eski = gunOnce(5);     // RETENTION_LOG_DAYS=1 -> bu eski
  const yeni = gunOnce(0);     // bugun -> korunmali

  writeLog(eski); signer.signDailyLog(eski);
  writeLog(yeni); signer.signDailyLog(yeni);

  const silinen = signer.purgeOldLogs();

  assert.strictEqual(silinen, 3, 'eski gunun .log/.log.gz/.ts uclusu silinmeli');
  for (const ext of ['.log', '.log.gz', '.ts']) {
    assert.ok(!fs.existsSync(path.join(LOGS_DIR, `${eski}${ext}`)), `${eski}${ext} silinmeliydi`);
    assert.ok(fs.existsSync(path.join(LOGS_DIR, `${yeni}${ext}`)), `${yeni}${ext} korunmaliydi`);
  }

  const chain = JSON.parse(fs.readFileSync(signer.CHAIN_PATH, 'utf8'));
  assert.ok(!(eski in chain), 'silinen gun zincir indeksinden de cikmali');
  assert.ok(yeni in chain);
});

test('purgeOldLogs silinecek dosya yoksa 0 doner', () => {
  const yeni = gunOnce(0);
  writeLog(yeni); signer.signDailyLog(yeni);

  assert.strictEqual(signer.purgeOldLogs(), 0);
});
