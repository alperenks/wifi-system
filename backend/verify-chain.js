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
  Doğrulama mantığı `verifyChain(logsDir)` olarak dışa aktarılır; testler bunu
  geçici bir log dizinine karşı çağırabilsin diye (CLI davranışı değişmedi).
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOGS_DIR, GENESIS } = require('./kamusm-signer');

/**
 * Zinciri doğrular. Süreci SONLANDIRMAZ — sonucu nesne olarak döndürür.
 * @param {string} logsDir Damga dosyalarının bulunduğu dizin
 * @returns {{ ok: boolean, verified: number, days: Array, error?: string }}
 */
function verifyChain(logsDir = LOGS_DIR) {
  const days = [];
  const fail = (error) => ({ ok: false, verified: days.length, days, error });

  if (!fs.existsSync(logsDir)) return fail(`Log dizini yok: ${logsDir}`);

  const tsFiles = fs.readdirSync(logsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.ts$/.test(f))
    .sort();

  if (tsFiles.length === 0) return fail('Hic damga (.ts) dosyasi bulunamadi. Once log imzalayin.');

  let expectedPrev = GENESIS;

  for (const tsFile of tsFiles) {
    const dateStr = tsFile.replace('.ts', '');
    const tsPath = path.join(logsDir, tsFile);
    const gzPath = path.join(logsDir, `${dateStr}.log.gz`);

    let ts;
    try { ts = JSON.parse(fs.readFileSync(tsPath, 'utf8')); }
    catch (e) { return fail(`${tsFile} okunamadi/bozuk: ${e.message}`); }

    // 1. .log.gz içeriği damgadaki hash ile uyuşuyor mu?
    if (!fs.existsSync(gzPath)) {
      return fail(`${dateStr}: .log.gz dosyasi eksik — icerik silinmis, dogrulanamaz.`);
    }
    const gzData = fs.readFileSync(gzPath);
    const actualHash = crypto.createHash('sha256').update(gzData).digest('hex');
    if (actualHash !== ts.hashedMessage) {
      return fail(`${dateStr}: icerik DEGISTIRILMIS — .log.gz'nin hash'i damgayla uyusmuyor.\n     damga:  ${ts.hashedMessage}\n     gercek: ${actualHash}`);
    }

    // 2. previousHash beklenen zincir başına bağlanıyor mu?
    if (ts.previousHash !== expectedPrev) {
      return fail(`${dateStr}: ZINCIR KOPUK — previousHash beklenenle uyusmuyor (arada bir gun silinmis olabilir).\n     beklenen: ${expectedPrev}\n     bulunan:  ${ts.previousHash}`);
    }

    // 3. chainHash gerçekten previousHash+hash+time'dan mı türetilmiş?
    const recomputed = crypto.createHash('sha256')
      .update(ts.previousHash + ts.hashedMessage + ts.productionTime)
      .digest('hex');
    if (recomputed !== ts.chainHash) {
      return fail(`${dateStr}: chainHash tutarsiz — damga alanlari kurcalanmis.`);
    }

    days.push({ dateStr, chainHash: ts.chainHash, mock: !!ts.mock });
    expectedPrev = ts.chainHash;
  }

  return { ok: true, verified: days.length, days };
}

function main() {
  console.log('\n==================================================================');
  console.log('  5651 LOG IMZA ZINCIRI DOGRULAMASI');
  console.log('==================================================================\n');

  const result = verifyChain();

  for (const d of result.days) {
    console.log(`  [OK] ${d.dateStr}  chainHash=${d.chainHash.slice(0, 16)}...${d.mock ? '  (mock imza)' : ''}`);
  }

  if (!result.ok) {
    console.log(`\n  SONUC: ZINCIR GECERSIZ\n  -> ${result.error}\n`);
    process.exit(1);
  }

  console.log(`\n  SONUC: ZINCIR GECERLI — ${result.verified} gun dogrulandi, kopukluk yok.\n`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { verifyChain };
