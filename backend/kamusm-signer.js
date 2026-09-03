const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cron = require('node-cron');
const config = require('./config');

const LOGS_DIR = path.join(__dirname, 'logs', '5651_captive');
const CHAIN_PATH = path.join(LOGS_DIR, 'chain.json');   // tarih -> chainHash indeksi
const GENESIS = '0'.repeat(64);

function loadChain() {
  try {
    if (fs.existsSync(CHAIN_PATH)) return JSON.parse(fs.readFileSync(CHAIN_PATH, 'utf8'));
  } catch (_) {}
  return {};
}

function saveChain(chain) {
  fs.writeFileSync(CHAIN_PATH, JSON.stringify(chain, null, 2), 'utf8');
}

// Verilen tarihten bir önceki imzalı günün chainHash'ini bulur (yoksa GENESIS).
function previousChainHash(chain, dateStr) {
  const dates = Object.keys(chain).filter(d => d < dateStr).sort();
  if (dates.length === 0) return GENESIS;
  return chain[dates[dates.length - 1]].chainHash;
}

/**
 * Günlük logu sıkıştırır, SHA-256'sını alır ve zincire bağlı bir damga (.ts) üretir.
 *
 * DÜRÜSTLÜK NOTU (F-08): Bu GERÇEK bir RFC 3161 zaman damgası DEĞİLDİR. Simülasyon
 * için, config.kamusm.mockKey ile HMAC üretilir ("mock": true olarak işaretlenir).
 * Gerçek dağıtımda burası KamuSM TSA'ya .tsq göndermeli ve .tsr saklamalıdır.
 * Ancak zincir yapısı (previousHash) gerçektir: bir günü silmek/değiştirmek zinciri
 * kırar ve verify-chain.js ile tespit edilir.
 *
 * @param {string} dateStr YYYY-MM-DD
 */
function signDailyLog(dateStr) {
  const logFilePath = path.join(LOGS_DIR, `${dateStr}.log`);
  const gzFilePath = path.join(LOGS_DIR, `${dateStr}.log.gz`);
  const tsFilePath = path.join(LOGS_DIR, `${dateStr}.ts`);

  if (!fs.existsSync(logFilePath)) {
    console.warn(`[KAMUSM] No log file found for date ${dateStr} to sign.`);
    return false;
  }

  try {
    console.log(`[KAMUSM] Starting signing process for log date: ${dateStr}`);

    // 1. Sıkıştır
    const logData = fs.readFileSync(logFilePath);
    const gzData = zlib.gzipSync(logData);
    fs.writeFileSync(gzFilePath, gzData);
    console.log(`[KAMUSM] Log file compressed to ${dateStr}.log.gz`);

    // 2. Sıkıştırılmış dosyanın SHA-256'sı
    const sha256 = crypto.createHash('sha256').update(gzData).digest('hex');
    console.log(`[KAMUSM] SHA-256 hash of gz: ${sha256}`);

    // 3. Zincir: önceki günün chainHash'ini al ve bu günü ona bağla (F-08)
    const chain = loadChain();
    const previousHash = previousChainHash(chain, dateStr);
    const signingTime = new Date().toISOString();
    const chainHash = crypto.createHash('sha256')
      .update(previousHash + sha256 + signingTime)
      .digest('hex');

    // 4. Damga dosyası — mock HMAC + zincir alanları
    const signature = crypto.createHmac('sha256', config.kamusm.mockKey)
      .update(chainHash)
      .digest('base64');

    const tsaResponse = {
      version: 1,
      mock: true,
      note: 'SIMULASYON: gercek RFC 3161 TSA yaniti degildir. Zincir (previousHash) gercektir.',
      policy: '1.2.840.113549.1.9.16.1.4',
      productionTime: signingTime,
      hashAlgorithm: 'SHA-256',
      hashedMessage: sha256,      // .log.gz'nin özeti
      previousHash,               // önceki günün chainHash'i
      chainHash,                  // bu günün zincir bağı
      serialNumber: crypto.randomBytes(6).toString('hex'),
      tsaName: 'CN=SIMULASYON Mock TSA, O=wifi-system, C=TR',
      status: { status: 'granted', statusString: 'Mock TSA processed (simulation).' },
      signature,
    };

    fs.writeFileSync(tsFilePath, JSON.stringify(tsaResponse, null, 2), 'utf8');

    // 5. Zincir indeksini güncelle
    chain[dateStr] = { chainHash, hashedMessage: sha256, productionTime: signingTime };
    saveChain(chain);

    console.log(`[KAMUSM] Timestamp file generated and chained: ${dateStr}.ts`);
    return tsaResponse;
  } catch (err) {
    console.error(`[KAMUSM] Failed to sign log for date ${dateStr}:`, err);
    throw err;
  }
}

// F-07: Saklama süresini aşan log/gz/ts üçlülerini siler.
function purgeOldLogs() {
  if (!fs.existsSync(LOGS_DIR)) return 0;
  const cutoff = Date.now() - config.retention.logDays * 86400 * 1000;
  let removed = 0;
  const chain = loadChain();
  for (const file of fs.readdirSync(LOGS_DIR)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const dateMs = Date.parse(m[1]);
    if (Number.isFinite(dateMs) && dateMs < cutoff) {
      for (const ext of ['.log', '.log.gz', '.ts']) {
        const p = path.join(LOGS_DIR, `${m[1]}${ext}`);
        if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
      }
      delete chain[m[1]];
    }
  }
  if (removed > 0) { saveChain(chain); console.log(`[RETENTION] ${removed} eski log dosyasi temizlendi.`); }
  return removed;
}

// Her gün 23:59'da imzala + saklama temizliği
function startCronSigner() {
  cron.schedule(config.kamusm.signHour, () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    console.log(`[CRON] Automatically triggered daily signing for: ${todayStr}`);
    try {
      signDailyLog(todayStr);
      purgeOldLogs();
    } catch (e) {
      console.error('[CRON] Daily signing cron failed:', e);
    }
  });
  console.log('[KAMUSM] Cron scheduler for log signing started (Runs daily at 23:59).');
}

module.exports = { signDailyLog, startCronSigner, purgeOldLogs, LOGS_DIR, CHAIN_PATH, GENESIS };
