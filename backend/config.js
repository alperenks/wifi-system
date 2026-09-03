/*
  =============================================================================
  Merkezi Yapılandırma (config.js)
  =============================================================================
  Tüm ayarlar .env dosyasından okunur. .env yoksa güvenli varsayılanlar kullanılır.
  Sahaya çıkmadan önce backend/.env.example dosyasını backend/.env olarak
  kopyalayıp gerçek NetGSM bilgilerinizi ve SIM_MODE=false değerini girin.

  GÜVENLİK NOTU: Üretim modunda (SIM_MODE=false) kritik sırlar boşsa sunucu
  başlamayı reddeder (aşağıdaki assertProductionSecrets). SIM_MODE'da ise
  geliştirme varsayılanları üretilir ve konsola uyarı basılır — böylece demo
  hiçbir yapılandırma olmadan çalışır ama bu değerlerin sahaya uygun OLMADIĞI
  açıkça bildirilir.
*/

require('dotenv').config();
const crypto = require('crypto');

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const SIM_MODE = bool(process.env.SIM_MODE, true);

// SIM_MODE'da eksik sırları çalışma zamanında üretilmiş rastgele değerlerle doldururuz.
// Bu değerler her başlatmada değişir — kalıcı değildir, yalnızca demoyu ayakta tutar.
function devSecret(label) {
  const v = crypto.randomBytes(24).toString('hex');
  console.warn(`[CONFIG] UYARI: ${label} .env'de tanımlı değil — SIM_MODE için geçici rastgele değer üretildi (sahada KULLANMAYIN).`);
  return v;
}

// scrypt tabanlı parola hash'i (auth.js ile aynı biçim: scrypt$salt$hash)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

const config = {
  // --- Genel ---
  PORT: int(process.env.PORT, 3000),

  // Simülasyon modu: true iken gerçek SMS gitmez, OTP arayüze/konsola düşer,
  // OTP doğrulanınca gerçek bir RADIUS oturumu YEREL sunucuya karşı otomatik açılır.
  SIM_MODE,

  // --- NetGSM (SMS OTP) ---
  netgsm: {
    username: process.env.NETGSM_USERNAME || '',
    password: process.env.NETGSM_PASSWORD || '',
    header: process.env.NETGSM_HEADER || '',
    appkey: process.env.NETGSM_APPKEY || '',
    otpMinutes: int(process.env.OTP_EXPIRE_MINUTES, 3),
  },

  // --- RADIUS ---
  radius: {
    secret: process.env.RADIUS_SECRET || (SIM_MODE ? 'sim-radius-secret' : ''),
    authPort: int(process.env.RADIUS_AUTH_PORT, 1812),
    acctPort: int(process.env.RADIUS_ACCT_PORT, 1813),
    serverHost: process.env.RADIUS_SERVER_HOST || '127.0.0.1',
  },

  // --- Ağ / Oturum profili ---
  session: {
    rateLimit: process.env.RATE_LIMIT || '5M/2M',
    timeoutSeconds: int(process.env.SESSION_TIMEOUT, 7200),
    lanPrefix: process.env.LAN_PREFIX || '192.168.20',
    leaseStart: int(process.env.LEASE_START, 100),
    leaseEnd: int(process.env.LEASE_END, 200),
  },

  // --- Güvenlik: OTP akışı (F-01, F-06) ---
  security: {
    otp: {
      maxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),   // bu kadar yanlıştan sonra akış kilitlenir
      flowRetentionHours: int(process.env.OTP_FLOW_RETENTION_HOURS, 24),
    },
    // Hız sınırları (F-02). Anahtar üretimi server.js'te; değerler burada.
    rateLimit: {
      otpPerMinute: int(process.env.RL_OTP_PER_MIN, 1),
      otpPerHour: int(process.env.RL_OTP_PER_HOUR, 5),
      otpPerPhonePerDay: int(process.env.RL_OTP_PER_PHONE_DAY, 10),
      verifyPerMinute: int(process.env.RL_VERIFY_PER_MIN, 10),
      loginPer15Min: int(process.env.RL_LOGIN_PER_15MIN, 5),
    },
  },

  // --- Yönetici girişi (F-12) ---
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    // .env'de ADMIN_PASSWORD_HASH beklenir (scrypt$salt$hash biçimi, auth.js ile üretilir).
    passwordHash: process.env.ADMIN_PASSWORD_HASH
      || (SIM_MODE ? hashPassword(process.env.ADMIN_PASSWORD || 'admin123') : ''),
    sessionSecret: process.env.ADMIN_SESSION_SECRET
      || (SIM_MODE ? devSecret('ADMIN_SESSION_SECRET') : ''),
    sessionTtlMinutes: int(process.env.ADMIN_SESSION_TTL_MIN, 60),
    // SIM_MODE'da varsayılan parola kullanıldıysa demoyu kolaylaştırmak için düz metni de tut.
    devPasswordPlain: SIM_MODE && !process.env.ADMIN_PASSWORD_HASH
      ? (process.env.ADMIN_PASSWORD || 'admin123') : null,
  },

  // --- ESP32 Access Point (fiziksel test) ---
  esp32: {
    apUrl: process.env.ESP32_AP_URL || '',
    // Backend ile ESP32 arasında paylaşılan HMAC sırrı (F-03).
    sharedSecret: process.env.ESP32_SHARED_SECRET
      || (SIM_MODE ? devSecret('ESP32_SHARED_SECRET') : ''),
    clockToleranceSec: int(process.env.ESP32_CLOCK_TOLERANCE_SEC, 30),
  },

  // --- TLS (F-05) ---
  tls: {
    enabled: bool(process.env.TLS_ENABLED, false),
    keyPath: process.env.TLS_KEY_PATH || '',
    certPath: process.env.TLS_CERT_PATH || '',
  },

  // --- Log / KamuSM ---
  kamusm: {
    tsaUrl: process.env.KAMUSM_TSA_URL || 'http://zd.kamusm.gov.tr',
    signHour: process.env.SIGN_CRON || '59 23 * * *',
    // Mock imza anahtarı artık kodda gömülü DEĞİL (F-08). Üretimde gerçek TSA kullanılır.
    mockKey: process.env.KAMUSM_MOCK_KEY || (SIM_MODE ? devSecret('KAMUSM_MOCK_KEY') : ''),
  },

  // --- Veritabanı yazma davranışı ---
  // Ardışık save() çağrıları bu pencerede tek bir diske yazmaya toplanır.
  // 0 = biriktirme kapalı (her çağrı hemen yazar).
  db: {
    saveDebounceMs: int(process.env.DB_SAVE_DEBOUNCE_MS, 200),
  },

  // --- Veri kotası (F-10) ---
  // Bir oturum bu kadar MB'ı aşınca RADIUS sunucusu NAS'a RFC 5176
  // Disconnect-Request gönderir ve oturumu kapatır. 0 = kota KAPALI (varsayılan).
  quota: {
    megabytes: int(process.env.QUOTA_MB, 0),
    coaPort: int(process.env.COA_PORT, 3799),   // NAS'ın CoA/DM dinleme portu (RFC 5176)
    coaHost: process.env.COA_HOST || '',        // boş = paketin geldiği NAS adresi kullanılır
  },

  // --- Veri saklama (F-07) — 5651: iki yıl ---
  retention: {
    sessionDays: int(process.env.RETENTION_SESSION_DAYS, 730),
    logDays: int(process.env.RETENTION_LOG_DAYS, 730),
  },
};

// ---------------------------------------------------------------------------
// Üretim modu sır kontrolü: eksik kritik sır varsa başlamayı reddet.
// ---------------------------------------------------------------------------
function assertProductionSecrets() {
  if (config.SIM_MODE) return;
  const missing = [];
  if (!config.admin.passwordHash) missing.push('ADMIN_PASSWORD_HASH');
  if (!config.admin.sessionSecret) missing.push('ADMIN_SESSION_SECRET');
  if (!config.esp32.sharedSecret && config.esp32.apUrl) missing.push('ESP32_SHARED_SECRET');
  if (!config.radius.secret) missing.push('RADIUS_SECRET');
  if (!config.netgsm.username || !config.netgsm.password) missing.push('NETGSM_USERNAME/PASSWORD');
  if (!config.kamusm.mockKey) missing.push('KAMUSM_MOCK_KEY (veya gerçek TSA yapılandırması)');
  if (missing.length) {
    console.error('\n[CONFIG] ÜRETİM MODU BAŞLATILAMADI — şu zorunlu sırlar .env\'de eksik:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('SIM_MODE=true ile demo çalıştırabilir veya .env\'i tamamlayabilirsiniz.\n');
    process.exit(1);
  }
}

config.assertProductionSecrets = assertProductionSecrets;
config.hashPassword = hashPassword;

module.exports = config;
