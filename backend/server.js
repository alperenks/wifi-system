const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const db = require('./db');
const netgsm = require('./netgsm');
const radiusClient = require('./radius-client');
const auth = require('./auth');
const { startRadiusServer } = require('./radius-server');
const { startSyslogServer } = require('./syslog-server');
const { startCronSigner, signDailyLog, purgeOldLogs } = require('./kamusm-signer');
const rateLimit = require('express-rate-limit');

// Üretim modunda kritik sırlar eksikse burada durur (config.js).
config.assertProductionSecrets();

const app = express();
const PORT = config.PORT;

// Gerçek istemci IP'sini (proxy arkasında) doğru okumak için — rate-limit anahtarı buna bağlı.
app.set('trust proxy', 1);

// F-02: express-rate-limit v7, IP içeren özel keyGenerator'da IPv6'yı normalize etmemizi ister.
// ipKeyGenerator yardımcısı bu sürümde dışa aktarılmadığından IP'yi elle normalize ediyoruz
// (IPv6'da /64 öneki — tek adresle limit atlatmayı zorlaştırır).
function clientKey(req) {
  let ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (ip.includes(':') && !ip.includes('.')) {
    ip = ip.split(':').slice(0, 4).join(':'); // IPv6 /64
  }
  return ip;
}
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

// Enable JSON parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================================================
//  Hız Sınırlayıcılar (F-02)
//  KURAL: istemciden gelen hiçbir değer (MAC gibi) TEK BAŞINA anahtar olamaz.
//  Anahtar daima gerçek IP'ye + (uygunsa) telefon numarasına bağlanır.
// ==========================================================================
const RL = config.security.rateLimit;

// IP + telefon başına dakikada 1 OTP
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RL.otpPerMinute,
  message: { message: 'Dakikada en fazla 1 SMS doğrulama kodu talep edebilirsiniz.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${clientKey(req)}|${digitsOnly(req.body && req.body.phone)}`
});

// IP + telefon başına saatte 5 OTP
const smsHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: RL.otpPerHour,
  message: { message: 'Saatte en fazla 5 SMS doğrulama kodu talep edebilirsiniz.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${clientKey(req)}|${digitsOnly(req.body && req.body.phone)}`
});

// Telefon numarası başına günde N OTP — MAC/IP değiştirilse bile bir numaraya
// gönderilebilecek SMS'i sınırlar (kurbanı bombalamayı ve maliyet saldırısını kapatır).
const phoneDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: RL.otpPerPhonePerDay,
  message: { message: 'Bu numaraya bugün için doğrulama kodu limiti doldu.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `phone:${digitsOnly(req.body && req.body.phone)}`
});

// F-01: OTP doğrulama uç noktasına IP başına dakikada 10 istek
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RL.verifyPerMinute,
  message: { message: 'Çok fazla doğrulama denemesi. Lütfen biraz bekleyin.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => clientKey(req)
});

// F-12: Yönetici girişine IP başına 15 dakikada 5 deneme
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RL.loginPer15Min,
  message: { message: 'Çok fazla başarısız giriş. 15 dakika sonra tekrar deneyin.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => clientKey(req)
});

// Telefon numarası biçim doğrulaması — limiter'lardan ÖNCE çalışır ki geçersiz
// numara için anahtar üretilmesin (5XXXXXXXXX, başında 0 yok).
function validatePhone(req, res, next) {
  const phone = digitsOnly(req.body && req.body.phone);
  if (!/^5[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ message: 'Telefon numarası başında 0 olmadan 5XXXXXXXXX formatında olmalıdır.' });
  }
  next();
}

// ==========================================================================
//  Popular destination catalog for realistic browsing simulation
// ==========================================================================
const SITE_CATALOG = [
  { domain: 'www.google.com', ip: '142.250.187.68', port: 443 },
  { domain: 'www.youtube.com', ip: '142.250.187.238', port: 443 },
  { domain: 'www.instagram.com', ip: '157.240.231.174', port: 443 },
  { domain: 'www.facebook.com', ip: '157.240.231.35', port: 443 },
  { domain: 'api.whatsapp.com', ip: '157.240.231.60', port: 443 },
  { domain: 'www.netflix.com', ip: '54.155.178.5', port: 443 },
  { domain: 'www.trendyol.com', ip: '104.16.90.188', port: 443 },
  { domain: 'www.hepsiburada.com', ip: '23.45.120.10', port: 443 },
  { domain: 'www.sahibinden.com', ip: '31.145.176.10', port: 443 },
  { domain: 'www.x.com', ip: '104.244.42.129', port: 443 },
  { domain: 'cdn.spotify.com', ip: '35.186.224.25', port: 443 },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Build a realistic pfSense "unbound" DNS query syslog line
function buildUnboundLog(localIp, domain) {
  const ts = new Date().toString().slice(4, 24);
  return `<13>${ts} pfSense unbound[90243]: info: ${localIp} ${domain}. A IN`;
}

// Build a realistic pfSense "filterlog" NAT/connection syslog line (IPv4 TCP)
function buildFilterLog(localIp, destIp, destPort, srcPort) {
  // fields: rule,,,tracker,iface,reason,action,dir,ipver,tos,ecn,ttl,id,off,flags,protoid,proto,len,src,dst,sport,dport,...
  return `<134>${new Date().toString().slice(4, 24)} pfSense filterlog: ` +
    `5,,,1000000103,em1,match,pass,out,4,0x0,,64,0,0,DF,6,tcp,60,` +
    `${localIp},${destIp},${srcPort},${destPort},0,S`;
}

// Emit a syslog line to our own UDP 514 receiver (exercises the real parser)
function emitSyslog(line) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(line);
    sock.send(buf, 0, buf.length, 514, '127.0.0.1', () => {
      sock.close();
      resolve();
    });
  });
}

// --- Page Routes ---
app.get('/captive', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'captive.html'));
});

app.get('/login', (req, res) => {
  // Zaten girişliyse doğrudan panele
  if (auth.getSession(req)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// F-12: panel yalnızca geçerli oturum çerezi ile açılır (yoksa /login'e yönlenir)
app.get('/dashboard', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.redirect('/captive');
});

// ==========================================================================
//  Yönetici Kimlik Doğrulama API'si (F-12)
// ==========================================================================
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { user, password } = req.body || {};
  const okUser = (user || '') === config.admin.user;
  const okPass = auth.verifyPassword(password || '', config.admin.passwordHash);
  if (!okUser || !okPass) {
    return res.status(401).json({ message: 'Kullanıcı adı veya parola hatalı.' });
  }
  auth.setSessionCookie(res, auth.issueToken(config.admin.user));
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = auth.getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: session.user });
});

// Expose runtime config (mode badge etc.) to the UI
// Sağlık kontrolü (D1). Kimlik doğrulaması YOKTUR: izleme aracı, yük dengeleyici
// veya saha teknisyeni "portal ayakta mı?" sorusunu tek istekle yanıtlayabilsin.
// Bu yüzden sır/kişisel veri sızdırmaz — yalnızca çalışma durumu döner.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),          // saniye
    mode: config.SIM_MODE ? 'simulation' : 'live',
    time: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    simMode: config.SIM_MODE,
    netgsmConfigured: Boolean(config.netgsm.username && config.netgsm.password),
    rateLimit: config.session.rateLimit,
    sessionTimeout: config.session.timeoutSeconds,
    lanPrefix: config.session.lanPrefix,
  });
});

// ==========================================================================
//  Captive Portal API
// ==========================================================================

// Send OTP via SMS (Simulated / NetGSM)
// Sıra: telefon doğrula -> telefon günlük limit -> IP+telefon saatlik/dakikalık limit
app.post('/api/send-otp', validatePhone, phoneDailyLimiter, smsHourlyLimiter, smsLimiter, async (req, res) => {
  const { mac, phone } = req.body;

  if (!mac || !phone) {
    return res.status(400).json({ message: 'MAC adresi ve telefon numarası gereklidir.' });
  }

  // F-06: kriptografik olarak güvenli 6 haneli OTP
  const otpCode = crypto.randomInt(100000, 1000000).toString();

  // Persist auth flow + reserve a DHCP-style IP lease for this device
  db.createGuestFlow(mac, phone, otpCode);
  const leaseIp = db.allocateIp(mac);

  console.log(`\n=================== [SMS OUTBOX] ===================`);
  console.log(`Gönderilen MAC   : ${mac}`);
  console.log(`Atanan IP (kira) : ${leaseIp}`);
  console.log(`Telefon Numarası : +90 ${phone}`);
  console.log(`Doğrulama Kodu   : ${otpCode}`);
  console.log(`Tarih            : ${new Date().toLocaleString()}`);
  console.log(`====================================================\n`);

  // Send through NetGSM module (auto-simulates when SIM_MODE or creds missing)
  const smsResult = await netgsm.sendOtpSms(phone, otpCode);

  const payload = {
    success: true,
    message: smsResult.simulated
      ? 'SMS doğrulama kodu üretildi (Simülasyon — gerçek SMS gönderilmedi).'
      : 'SMS doğrulama kodu telefonunuza gönderildi.',
    simulated: Boolean(smsResult.simulated),
    leaseIp,
  };

  // Only leak the code back to the UI when simulating (no real SMS delivered)
  if (smsResult.simulated) payload.otpCode = otpCode;
  if (!smsResult.success) {
    return res.status(502).json({ message: smsResult.error || 'SMS gönderilemedi.' });
  }

  return res.json(payload);
});

// Verify OTP -> authenticate device through the REAL RADIUS path
app.post('/api/verify-otp', verifyLimiter, async (req, res) => {
  const { mac, otp } = req.body;

  if (!mac || !otp) {
    return res.status(400).json({ message: 'MAC adresi ve şifre gereklidir.' });
  }

  // F-01/F-06: sonuç artık nesne — reason'a göre farklı yanıt
  const result = db.verifyGuestFlow(mac, otp);
  if (!result.ok) {
    if (result.reason === 'locked') {
      console.warn(`[AUTH-FLOW] MAC ${mac} akisi kilitlendi (cok fazla yanlis deneme).`);
      return res.status(429).json({ message: 'Çok fazla hatalı deneme. Lütfen yeni bir kod isteyin.' });
    }
    if (result.reason === 'bad_code') {
      console.warn(`[AUTH-FLOW] MAC ${mac} hatali OTP. Kalan deneme: ${result.remaining}`);
      return res.status(400).json({ message: `Hatalı doğrulama kodu. Kalan deneme hakkı: ${result.remaining}.`, remaining: result.remaining });
    }
    // expired | no_flow
    return res.status(400).json({ message: 'Doğrulama kodunun süresi geçmiş veya geçersiz. Yeni bir kod isteyin.' });
  }

  console.log(`[AUTH-FLOW] MAC ${mac} OTP doğrulandı. RADIUS kimlik doğrulaması başlatılıyor...`);
  const leaseIp = db.allocateIp(mac);

  // SIM_MODE'da Node aynı zamanda NAS'ı oynar: cihazı F-04 oturum sırrıyla doğrular
  // ve yerel RADIUS'a gerçek bir accounting oturumu açar.
  let radiusResult = null;
  if (config.SIM_MODE) {
    try {
      const radAuth = await radiusClient.authenticate(mac, result.sessionSecret);
      if (radAuth.accepted) {
        const sessionId = 'sim-' + crypto.randomBytes(4).toString('hex');
        await radiusClient.accountingStart(mac, leaseIp, sessionId);
        radiusResult = { accepted: true, sessionId, ip: leaseIp, attributes: radAuth.attributes };
        console.log(`[SIM-NAS] Oturum açıldı. MAC:${mac} IP:${leaseIp} Session:${sessionId}`);
      } else {
        radiusResult = { accepted: false };
        console.warn(`[SIM-NAS] RADIUS Access-Reject: ${mac}`);
      }
    } catch (err) {
      console.error('[SIM-NAS] RADIUS akışı hata verdi:', err.message);
    }
  }

  // F-03: Fiziksel ESP32'ye HMAC imzalı POST ile yetkilendirme (imzasız GET kaldırıldı)
  if (config.esp32.apUrl) {
    notifyEsp32Authorize(mac).catch((e) => console.warn(`[ESP32] Yetkilendirme başarısız (${e.message})`));
  }

  return res.json({
    success: true,
    message: 'Kimlik doğrulama başarılı. İnternet erişiminiz açıldı.',
    leaseIp,
    radius: radiusResult,
  });
});

// F-03: ESP32 köprüsüne imzalı yetkilendirme isteği.
// Gövde {mac, ts, nonce}, başlık X-Signature = HMAC-SHA256(gövdenin birebir metni, sharedSecret).
// ESP32 tarafı imzayı + zaman penceresini + nonce tekrarını doğrular (replay koruması).
async function notifyEsp32Authorize(mac) {
  const cleanMac = mac.toLowerCase();
  const payload = JSON.stringify({
    mac: cleanMac,
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(8).toString('hex'),
  });
  const signature = crypto.createHmac('sha256', config.esp32.sharedSecret).update(payload).digest('hex');
  const url = `${config.esp32.apUrl.replace(/\/$/, '')}/authorize`;
  await axios.post(url, payload, {
    timeout: 3000,
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
  });
  console.log(`[ESP32] ${cleanMac} imzali istekle yetkilendirildi -> ${url}`);
}

// ==========================================================================
//  Simulation control API (for demo & learning — no hardware needed)
// ==========================================================================

// Full virtual guest: phone -> OTP -> verify -> RADIUS session, in one call
app.post('/api/sim/full-guest', auth.requireAuth, async (req, res) => {
  if (!config.SIM_MODE) {
    return res.status(400).json({ message: 'Bu uç yalnızca SIM_MODE aktifken kullanılabilir.' });
  }
  const phone = req.body.phone || ('5' + Math.floor(300000000 + Math.random() * 699999999));
  const mac = req.body.mac || randomMac();

  const otpCode = crypto.randomInt(100000, 1000000).toString();
  db.createGuestFlow(mac, phone, otpCode);
  const leaseIp = db.allocateIp(mac);
  const vr = db.verifyGuestFlow(mac, otpCode);   // F-04: oturum sırrını al
  if (!vr.ok) return res.status(500).json({ message: 'Simülasyon akışı doğrulanamadı.', reason: vr.reason });

  try {
    const radAuth = await radiusClient.authenticate(mac, vr.sessionSecret);
    if (!radAuth.accepted) return res.status(500).json({ message: 'RADIUS Access-Reject.' });
    const sessionId = 'sim-' + crypto.randomBytes(4).toString('hex');
    await radiusClient.accountingStart(mac, leaseIp, sessionId);
    console.log(`[SIM] Sanal misafir hazır. Tel:+90${phone} MAC:${mac} IP:${leaseIp}`);
    return res.json({ success: true, phone, mac, ip: leaseIp, sessionId });
  } catch (err) {
    return res.status(500).json({ message: 'Simülasyon oturumu açılamadı.', error: err.message });
  }
});

// Generate realistic browsing traffic (DNS + NAT syslog) for an active IP
app.post('/api/sim/browse', auth.requireAuth, async (req, res) => {
  const { ip } = req.body;
  const count = Math.min(parseInt(req.body.count || '5', 10), 25);
  if (!ip) return res.status(400).json({ message: 'ip alanı gereklidir.' });

  const visited = [];
  for (let i = 0; i < count; i++) {
    const site = pick(SITE_CATALOG);
    const srcPort = 40000 + Math.floor(Math.random() * 20000);
    await emitSyslog(buildUnboundLog(ip, site.domain));
    await emitSyslog(buildFilterLog(ip, site.ip, site.port, srcPort));
    visited.push(site.domain);
  }

  // Simulate traffic accounting growth for the active session
  const session = db.data.radacct.find(s => s.ip === ip && s.active);
  if (session) {
    const inc = 1024 * 1024 * count; // ~1MB per visit
    try {
      await radiusClient.accountingUpdate(session.username, session.sessionId,
        session.inputOctets + inc, session.outputOctets + Math.round(inc / 4));
    } catch (_) { /* best effort */ }
  }

  res.json({ success: true, ip, visited });
});

// Disconnect a device (RADIUS Accounting-Stop)
app.post('/api/sim/disconnect', auth.requireAuth, async (req, res) => {
  const { ip, mac } = req.body;
  const session = db.data.radacct.find(s => s.active && (s.ip === ip || s.username === (mac || '').toLowerCase().replace(/[^a-f0-9]/g, '')));
  if (!session) return res.status(404).json({ message: 'Aktif oturum bulunamadı.' });
  try {
    await radiusClient.accountingStop(session.username, session.sessionId,
      session.inputOctets, session.outputOctets);
    res.json({ success: true, sessionId: session.sessionId });
  } catch (err) {
    res.status(500).json({ message: 'Oturum kapatılamadı.', error: err.message });
  }
});

function randomMac() {
  const h = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${h()}:${h()}:${h()}:${h()}:${h()}:${h()}`;
}

// ==========================================================================
//  Dashboard API
//  F-12: Bu bölümün TAMAMI yönetici oturumu gerektirir. Guard burada tek yerde
//  uygulanır; aşağıdaki tüm /api/dashboard/* uçları otomatik korunur.
// ==========================================================================
app.use('/api/dashboard', auth.requireAuth);

app.get('/api/dashboard/sessions', (req, res) => {
  const sessions = db.data.radacct.map(sess => ({
    ...sess,
    phone: db.getPhoneByMac(sess.username)
  }));
  sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.startTime - a.startTime);
  res.json(sessions);
});

app.get('/api/dashboard/logs', (req, res) => {
  const dateStr = new Date().toISOString().slice(0, 10);
  const logFilePath = path.join(__dirname, 'logs', '5651_captive', `${dateStr}.log`);
  if (fs.existsSync(logFilePath)) {
    res.json({ logs: fs.readFileSync(logFilePath, 'utf8') });
  } else {
    res.json({ logs: '' });
  }
});

// Query historical logs by phone or MAC (5651 audit lookup)
app.get('/api/dashboard/search', (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase().trim();
  if (!q) return res.json({ matches: [] });
  const logsDir = path.join(__dirname, 'logs', '5651_captive');
  const matches = [];
  if (fs.existsSync(logsDir)) {
    for (const file of fs.readdirSync(logsDir).filter(f => f.endsWith('.log'))) {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      for (const line of content.split('\n')) {
        if (line.toLowerCase().includes(q)) matches.push({ file, line });
      }
    }
  }
  res.json({ matches: matches.slice(-500) });
});

app.post('/api/dashboard/sign-logs', (req, res) => {
  const todayStr = new Date().toISOString().slice(0, 10);
  try {
    const tsaResponse = signDailyLog(todayStr);
    if (tsaResponse) {
      res.json({ success: true, date: todayStr, response: tsaResponse });
    } else {
      res.status(404).json({ message: 'Bugüne ait herhangi bir log dosyası bulunamadı.' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Mühürleme işlemi başarısız oldu.', error: err.message });
  }
});

// F-12 ek koruma: 5651 delil logu ÜRETİMDE API ile silinemez. Bu uç yalnızca
// SIM_MODE'da (demo temizliği için) çalışır. Kanunun istediği değiştirilemezliktir.
app.post('/api/dashboard/clear-logs', (req, res) => {
  if (!config.SIM_MODE) {
    return res.status(403).json({ message: '5651 logları üretim modunda API ile silinemez.' });
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const base = path.join(__dirname, 'logs', '5651_captive');
  for (const ext of ['.log', '.log.gz', '.ts']) {
    const p = path.join(base, `${dateStr}${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ success: true });
});

// Reset all in-memory/JSON state (clean demo) — yalnızca SIM_MODE
app.post('/api/dashboard/reset', (req, res) => {
  if (!config.SIM_MODE) {
    return res.status(403).json({ message: 'Durum sıfırlama yalnızca simülasyon modunda kullanılabilir.' });
  }
  db.data.guestFlows = [];
  db.data.radcheck = {};
  db.data.radreply = {};
  db.data.radacct = [];
  db.data.leases = {};
  db.save();
  res.json({ success: true });
});

// Manual mock syslog (kept for backward compatibility)
app.post('/api/dashboard/mock-syslog', (req, res) => {
  const { type, localIp } = req.body;
  let message = '';
  if (type === 'dns') {
    message = `MOCK_DNS: localIp=${localIp} domain=${req.body.domain}`;
  } else {
    const { destIp, destPort, srcPort } = req.body;
    message = `MOCK_LOG: localIp=${localIp} destIp=${destIp} destPort=${destPort} srcPort=${srcPort} proto=TCP`;
  }
  const client = dgram.createSocket('udp4');
  const buffer = Buffer.from(message);
  client.send(buffer, 0, buffer.length, 514, '127.0.0.1', (err) => {
    client.close();
    if (err) res.status(500).json({ error: err.message });
    else res.json({ success: true });
  });
});

// ==========================================================================
//  Boot
// ==========================================================================
function onListening(scheme) {
  console.log(`\n=================== [PORTAL SUNUCUSU BASLADI] ===================`);
  console.log(`Mod                        : ${config.SIM_MODE ? 'SIMÜLASYON (gerçek SMS yok)' : 'CANLI (NetGSM aktif)'}`);
  console.log(`Captive Portal Web Arayüzü : ${scheme}://localhost:${PORT}/captive`);
  console.log(`Yönetici Girişi            : ${scheme}://localhost:${PORT}/login`);
  console.log(`Yönetici Kontrol Paneli    : ${scheme}://localhost:${PORT}/dashboard`);
  if (config.SIM_MODE && config.admin.devPasswordPlain) {
    console.log(`Yönetici (SIM demo)        : ${config.admin.user} / ${config.admin.devPasswordPlain}`);
  }
  console.log(`=================================================================\n`);

  startRadiusServer();
  startSyslogServer();
  startCronSigner();

  // F-10: Veri kotası açıksa, yazılım NAS'ın CoA/DM dinleyicisini de kaldır —
  // kotayı aşan oturum için RADIUS sunucusu buraya Disconnect-Request gönderir.
  if (config.quota.megabytes > 0) {
    console.log(`[QUOTA] Veri kotasi AKTIF: oturum basina ${config.quota.megabytes} MB (asilinca RFC 5176 Disconnect).`);
    radiusClient.startCoaListener();
  }

  // F-07: başlangıçta bir kez saklama temizliği (süresi geçmiş kayıt/loglar)
  try { db.purgeExpired(); purgeOldLogs(); } catch (e) { console.warn('[RETENTION] baslangic temizligi hata:', e.message); }
}

// F-05: TLS açıksa HTTPS ile dinle (varsayılan kapalı — SIM demosu HTTP ile çalışır).
if (config.tls.enabled) {
  try {
    const creds = {
      key: fs.readFileSync(config.tls.keyPath),
      cert: fs.readFileSync(config.tls.certPath),
    };
    https.createServer(creds, app).listen(PORT, () => onListening('https'));
  } catch (e) {
    console.error('[TLS] Sertifika yüklenemedi, başlatılamıyor:', e.message);
    process.exit(1);
  }
} else {
  app.listen(PORT, () => onListening('http'));
}
