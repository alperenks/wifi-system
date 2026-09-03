/*
  =============================================================================
  gen-cert.js — Kendinden İmzalı TLS Sertifikası Üretici (F-05)
  =============================================================================
  Captive portal'da parola/OTP ve telefon numarası taşındığı için sahada TLS
  ZORUNLUDUR. Bu betik, test/saha kurulumu için kendinden imzalı bir sertifika
  üretir; ek npm bağımlılığı yoktur, sistemdeki `openssl` kullanılır
  (Windows'ta Git for Windows ile birlikte gelir, pfSense'te zaten vardır).

  Kullanım:
    npm run gen-cert                    # CN=localhost
    npm run gen-cert -- 192.168.20.1    # portal IP'si de SAN'a eklenir
    npm run gen-cert -- portal.restoran.local --force

  Üretilenler:  backend/certs/portal-key.pem , backend/certs/portal-cert.pem
  (.gitignore *.pem'i zaten dışlıyor — anahtar repoya girmez.)

  NOT: Kendinden imzalı sertifikada tarayıcı uyarı gösterir; bu beklenen
  durumdur. Gerçek müşteri kurulumunda Let's Encrypt / kurumsal CA tercih edin.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'portal-key.pem');
const CRT_PATH = path.join(CERT_DIR, 'portal-cert.pem');
const GUN = 825;   // tarayıcıların kabul ettiği üst sınır

const args = process.argv.slice(2);
const force = args.includes('--force');
const hedef = args.find(a => !a.startsWith('--')) || 'localhost';

const ipMi = /^\d{1,3}(\.\d{1,3}){3}$/.test(hedef);

function cik(mesaj, kod = 1) {
  console.error(`\n  ${mesaj}\n`);
  process.exit(kod);
}

// --- openssl var mı? ---------------------------------------------------------
const surum = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (surum.error || surum.status !== 0) {
  cik([
    'openssl bulunamadi.',
    '',
    '  Windows: Git for Windows kuruluysa openssl PATH\'te olur',
    '           (C:\\Program Files\\Git\\usr\\bin\\openssl.exe).',
    '  Linux/pfSense: openssl zaten kuruludur.',
    '',
    '  Kurduktan sonra bu komutu tekrar calistirin: npm run gen-cert',
  ].join('\n'));
}

// --- Zaten var mı? -----------------------------------------------------------
if (!force && (fs.existsSync(KEY_PATH) || fs.existsSync(CRT_PATH))) {
  cik([
    'Sertifika dosyalari zaten var:',
    `    ${KEY_PATH}`,
    `    ${CRT_PATH}`,
    '',
    '  Uzerine yazmak icin: npm run gen-cert -- --force',
  ].join('\n'));
}

// --- openssl yapılandırması (geçici dosya) -----------------------------------
// -subj yerine config dosyasi kullaniyoruz: Git Bash (MSYS) "/C=TR" gibi
// degerleri yol sanip bozuyor; config dosyasi her kabukta ayni calisir.
const sanSatiri = ipMi
  ? `subjectAltName = DNS:localhost, IP:127.0.0.1, IP:${hedef}`
  : (hedef === 'localhost'
    ? 'subjectAltName = DNS:localhost, IP:127.0.0.1'
    : `subjectAltName = DNS:localhost, DNS:${hedef}, IP:127.0.0.1`);

const cnf = [
  '[req]',
  'prompt = no',
  'distinguished_name = dn',
  'x509_extensions = v3_req',
  '',
  '[dn]',
  'C = TR',
  'O = wifi-system',
  'OU = Misafir WiFi Portali',
  `CN = ${hedef}`,
  '',
  '[v3_req]',
  'basicConstraints = CA:FALSE',
  'keyUsage = digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  sanSatiri,
  '',
].join('\n');

const cnfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-cert-')), 'openssl.cnf');
fs.writeFileSync(cnfPath, cnf, 'utf8');

// --- Üret --------------------------------------------------------------------
fs.mkdirSync(CERT_DIR, { recursive: true });

const sonuc = spawnSync('openssl', [
  'req', '-x509',
  '-newkey', 'rsa:2048',
  '-nodes',                       // anahtar parolasiz (sunucu otomatik acilsin)
  '-keyout', KEY_PATH,
  '-out', CRT_PATH,
  '-days', String(GUN),
  '-config', cnfPath,
  '-extensions', 'v3_req',
], { encoding: 'utf8' });

try { fs.rmSync(path.dirname(cnfPath), { recursive: true, force: true }); } catch (_) {}

if (sonuc.status !== 0) {
  cik(`openssl sertifika uretemedi:\n${sonuc.stderr || sonuc.stdout}`);
}

// Anahtar dosyasini yalnizca sahibi okuyabilsin (POSIX; Windows'ta etkisiz).
try { fs.chmodSync(KEY_PATH, 0o600); } catch (_) {}

// --- Özet --------------------------------------------------------------------
const ozet = spawnSync('openssl', ['x509', '-in', CRT_PATH, '-noout', '-subject', '-dates'],
  { encoding: 'utf8' });

console.log('\n==================================================================');
console.log('  TLS SERTIFIKASI URETILDI (kendinden imzali)');
console.log('==================================================================\n');
console.log(`  Anahtar : ${KEY_PATH}`);
console.log(`  Sertifika: ${CRT_PATH}`);
if (ozet.status === 0) console.log('\n' + ozet.stdout.trim().split('\n').map(l => '  ' + l).join('\n'));
console.log('\n  Simdi backend/.env dosyaniza sunlari ekleyin:\n');
console.log('    TLS_ENABLED=true');
console.log('    TLS_KEY_PATH=certs/portal-key.pem');
console.log('    TLS_CERT_PATH=certs/portal-cert.pem');
console.log('\n  Ardindan "npm start" ile sunucu HTTPS dinler:');
console.log('    https://localhost:3000/captive');
console.log('\n  Tarayici "guvenli degil" uyarisi verecektir — kendinden imzali');
console.log('  sertifikada bu normaldir. Musteri kurulumunda gercek CA kullanin.\n');
