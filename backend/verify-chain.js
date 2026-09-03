/*
  =============================================================================
  verify-chain.js — 5651 Log İmza Zinciri Doğrulayıcı (F-08)
  =============================================================================
  Tüm günlük damga (.ts) dosyalarını tarih sırasıyla gezer ve iki şeyi doğrular:
    1. Her .log.gz'nin SHA-256'sı, damgadaki hashedMessage ile aynı mı?
       (içerik değiştirilmiş mi?)
    2. Her günün previousHash'i, bir önceki günün chainHash'ine bağlanıyor mu?
       (bir gün silinmiş/araya girilmiş mi?)

  İlk kopmayı ve nedenini bildirir. Bir günü silmek veya içeriğini değiştirmek
  zinciri kırar ve burada yakalanır — sistemi "günlük damga"dan gerçek bir
  DELİL ZİNCİRİNE çeviren şey budur.

  Kullanım:  npm run verify-chain
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOGS_DIR, GENESIS } = require('./kamusm-signer');

function fail(msg) {
  console.log(`\n  SONUC: ZINCIR GECERSIZ\n  -> ${msg}\n`);
  process.exit(1);
}

function main() {
  console.log('\n==================================================================');
  console.log('  5651 LOG IMZA ZINCIRI DOGRULAMASI');
  console.log('==================================================================\n');

  if (!fs.existsSync(LOGS_DIR)) fail(`Log dizini yok: ${LOGS_DIR}`);

  const tsFiles = fs.readdirSync(LOGS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.ts$/.test(f))
    .sort();

  if (tsFiles.length === 0) fail('Hic damga (.ts) dosyasi bulunamadi. Once log imzalayin.');

  let expectedPrev = GENESIS;
  let verified = 0;

  for (const tsFile of tsFiles) {
    const dateStr = tsFile.replace('.ts', '');
    const tsPath = path.join(LOGS_DIR, tsFile);
    const gzPath = path.join(LOGS_DIR, `${dateStr}.log.gz`);

    let ts;
    try { ts = JSON.parse(fs.readFileSync(tsPath, 'utf8')); }
    catch (e) { fail(`${tsFile} okunamadi/bozuk: ${e.message}`); }

    // 1. .log.gz içeriği damgadaki hash ile uyuşuyor mu?
    if (!fs.existsSync(gzPath)) {
      fail(`${dateStr}: .log.gz dosyasi eksik — icerik silinmis, dogrulanamaz.`);
    }
    const gzData = fs.readFileSync(gzPath);
    const actualHash = crypto.createHash('sha256').update(gzData).digest('hex');
    if (actualHash !== ts.hashedMessage) {
      fail(`${dateStr}: icerik DEGISTIRILMIS — .log.gz'nin hash'i damgayla uyusmuyor.\n     damga:  ${ts.hashedMessage}\n     gercek: ${actualHash}`);
    }

    // 2. previousHash beklenen zincir başına bağlanıyor mu?
    if (ts.previousHash !== expectedPrev) {
      fail(`${dateStr}: ZINCIR KOPUK — previousHash beklenenle uyusmuyor (arada bir gun silinmis olabilir).\n     beklenen: ${expectedPrev}\n     bulunan:  ${ts.previousHash}`);
    }

    // 3. chainHash gerçekten previousHash+hash+time'dan mı türetilmiş?
    const recomputed = crypto.createHash('sha256')
      .update(ts.previousHash + ts.hashedMessage + ts.productionTime)
      .digest('hex');
    if (recomputed !== ts.chainHash) {
      fail(`${dateStr}: chainHash tutarsiz — damga alanlari kurcalanmis.`);
    }

    console.log(`  [OK] ${dateStr}  chainHash=${ts.chainHash.slice(0, 16)}...${ts.mock ? '  (mock imza)' : ''}`);
    expectedPrev = ts.chainHash;
    verified++;
  }

  console.log(`\n  SONUC: ZINCIR GECERLI — ${verified} gun dogrulandi, kopukluk yok.\n`);
  process.exit(0);
}

main();
