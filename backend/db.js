const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DB_PATH = path.join(__dirname, 'db.json');

// OTP'yi flow'a özgü salt ile hash'ler (F-06: düz metin saklama yok).
function hashOtp(salt, otp) {
  return crypto.createHash('sha256').update(salt + ':' + otp).digest('hex');
}

// İki hex string'i sabit zamanlı karşılaştırır (F-06: timing attack'a kapalı).
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class Database {
  constructor() {
    this.data = {
      guestFlows: [], // { id, phone, mac, salt, otpHash, expiresAt, attempts, lockedAt, verified, verifiedAt, sessionSecret }
      radcheck: {},   // mac: { username, password }  (password artık rastgele oturum sırrı — F-04)
      radreply: {},   // mac: { 'Mikrotik-Rate-Limit', 'Session-Timeout', ... }
      radacct: [],    // { sessionId, username, ip, startTime, endTime, inputOctets, outputOctets, active }
      leases: {}      // mac: ip
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const fileContent = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(fileContent);
        this.data = Object.assign({
          guestFlows: [], radcheck: {}, radreply: {}, radacct: [], leases: {}
        }, parsed);
      } else {
        this.save();
      }
    } catch (err) {
      console.error('Failed to load database, using memory defaults:', err);
    }
  }

  // --- DHCP Kirası Taklidi (MAC <-> IP) ---
  allocateIp(mac) {
    const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
    if (this.data.leases[cleanMac]) return this.data.leases[cleanMac];

    const { lanPrefix, leaseStart, leaseEnd } = config.session;
    const used = new Set(Object.values(this.data.leases));
    for (let host = leaseStart; host <= leaseEnd; host++) {
      const candidate = `${lanPrefix}.${host}`;
      if (!used.has(candidate)) {
        this.data.leases[cleanMac] = candidate;
        this.save();
        return candidate;
      }
    }
    const fallback = `${lanPrefix}.${leaseStart}`;
    this.data.leases[cleanMac] = fallback;
    this.save();
    return fallback;
  }

  getMacByIp(ip) {
    const entry = Object.entries(this.data.leases).find(([, leasedIp]) => leasedIp === ip);
    return entry ? entry[0] : null;
  }

  save() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save database to disk:', err);
    }
  }

  // --- Guest Flow Operations ---
  createGuestFlow(mac, phone, otp) {
    const expiresAt = Date.now() + config.netgsm.otpMinutes * 60 * 1000;
    const salt = crypto.randomBytes(8).toString('hex');
    const flow = {
      id: crypto.randomBytes(6).toString('hex'),
      mac: mac.toLowerCase().replace(/[^a-f0-9]/g, ''),
      phone,
      salt,
      otpHash: hashOtp(salt, otp),   // F-06: OTP düz metin saklanmaz
      expiresAt,
      attempts: 0,                    // F-01: yanlış deneme sayacı
      lockedAt: null,
      verified: false,
      verifiedAt: null,
      sessionSecret: null,
    };
    // Aynı MAC için bekleyen eski akışları temizle
    this.data.guestFlows = this.data.guestFlows.filter(f => f.mac !== flow.mac || f.verified);
    this.data.guestFlows.push(flow);
    this.save();
    return flow;
  }

  getPendingFlow(mac) {
    const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
    const now = Date.now();
    return this.data.guestFlows.find(f => f.mac === cleanMac && !f.verified && f.expiresAt > now);
  }

  // F-01/F-06: dönüş artık nesne — { ok, reason, remaining, sessionSecret }
  // reason: ok | no_flow | expired | locked | bad_code
  verifyGuestFlow(mac, otp) {
    const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
    const now = Date.now();

    // Süresi/doğrulaması ne olursa olsun bu MAC'in en güncel akışını bul
    const flow = [...this.data.guestFlows].reverse().find(f => f.mac === cleanMac && !f.verified);

    if (!flow) return { ok: false, reason: 'no_flow' };
    if (flow.lockedAt) return { ok: false, reason: 'locked' };
    if (flow.expiresAt <= now) return { ok: false, reason: 'expired' };

    const candidate = hashOtp(flow.salt, String(otp));
    if (!safeEqualHex(candidate, flow.otpHash)) {
      flow.attempts += 1;
      const remaining = Math.max(0, config.security.otp.maxAttempts - flow.attempts);
      if (flow.attempts >= config.security.otp.maxAttempts) {
        flow.lockedAt = now;   // F-01: kilitle, yeni OTP şart
        this.save();
        return { ok: false, reason: 'locked', remaining: 0 };
      }
      this.save();
      return { ok: false, reason: 'bad_code', remaining };
    }

    // Başarılı doğrulama
    flow.verified = true;
    flow.verifiedAt = now;

    // F-04: RADIUS parolası artık MAC değil, rastgele oturum sırrı
    const sessionSecret = crypto.randomBytes(16).toString('hex');
    flow.sessionSecret = sessionSecret;

    this.data.radcheck[cleanMac] = { username: cleanMac, password: sessionSecret };

    const [downMbps, upMbps] = config.session.rateLimit.split('/');
    const toBps = (v) => Math.round(parseFloat(v) * 1024 * 1024 / 8) || 0;
    this.data.radreply[cleanMac] = {
      'Mikrotik-Rate-Limit': config.session.rateLimit,
      'Session-Timeout': String(config.session.timeoutSeconds),
      'WISPr-Bandwidth-Max-Down': String(toBps(downMbps) * 8),
      'WISPr-Bandwidth-Max-Up': String(toBps(upMbps) * 8)
    };

    this.save();
    return { ok: true, reason: 'ok', sessionSecret };
  }

  // --- RADIUS Check Operations ---
  getRadCheck(username) {
    const cleanUser = username.toLowerCase().replace(/[^a-f0-9]/g, '');
    return this.data.radcheck[cleanUser] || null;
  }

  getRadReply(username) {
    const cleanUser = username.toLowerCase().replace(/[^a-f0-9]/g, '');
    return this.data.radreply[cleanUser] || null;
  }

  // --- RADIUS Accounting Operations ---
  startSession(sessionId, username, ip) {
    const cleanUser = username.toLowerCase().replace(/[^a-f0-9]/g, '');
    this.data.radacct.forEach(sess => {
      if ((sess.sessionId === sessionId || sess.username === cleanUser) && sess.active) {
        sess.active = false;
        sess.endTime = Date.now();
      }
    });

    this.data.radacct.push({
      sessionId,
      username: cleanUser,
      ip,
      startTime: Date.now(),
      endTime: null,
      inputOctets: 0,
      outputOctets: 0,
      active: true
    });
    this.save();
  }

  stopSession(sessionId, inputOctets, outputOctets) {
    const session = this.data.radacct.find(sess => sess.sessionId === sessionId && sess.active);
    if (session) {
      session.active = false;
      session.endTime = Date.now();
      session.inputOctets = inputOctets || 0;
      session.outputOctets = outputOctets || 0;
      this.save();
    }
  }

  updateSession(sessionId, inputOctets, outputOctets) {
    const session = this.data.radacct.find(sess => sess.sessionId === sessionId && sess.active);
    if (session) {
      session.inputOctets = inputOctets || 0;
      session.outputOctets = outputOctets || 0;
      this.save();
    }
  }

  // --- IP to Phone Mapping ---
  getPhoneByIp(ip) {
    const activeSession = this.data.radacct.find(sess => sess.ip === ip && sess.active);
    if (activeSession) {
      const verifiedFlow = this.data.guestFlows.find(f => f.mac === activeSession.username && f.verified);
      if (verifiedFlow) return verifiedFlow.phone;
    }
    const leasedMac = this.getMacByIp(ip);
    if (leasedMac) {
      const flow = this.data.guestFlows.find(f => f.mac === leasedMac && f.verified);
      if (flow) return flow.phone;
    }
    return 'BILINMEYEN_TEL';
  }

  getPhoneByMac(mac) {
    const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
    const verifiedFlow = this.data.guestFlows.find(f => f.mac === cleanMac && f.verified);
    return verifiedFlow ? verifiedFlow.phone : 'BILINMEYEN_TEL';
  }

  // --- F-07: Veri saklama temizliği ---
  // Süresi geçmiş doğrulanmamış akışları ve saklama süresini aşan oturumları siler.
  purgeExpired() {
    const now = Date.now();
    const flowCutoff = now - config.security.otp.flowRetentionHours * 3600 * 1000;
    const sessionCutoff = now - config.retention.sessionDays * 86400 * 1000;

    const beforeFlows = this.data.guestFlows.length;
    // Doğrulanmış akışlar oturum kaydına bağlıdır; yalnızca doğrulanmamış ve eski olanları at.
    this.data.guestFlows = this.data.guestFlows.filter(f =>
      f.verified || f.expiresAt > flowCutoff);

    const beforeAcct = this.data.radacct.length;
    this.data.radacct = this.data.radacct.filter(s =>
      s.active || (s.endTime || s.startTime) > sessionCutoff);

    const removed = (beforeFlows - this.data.guestFlows.length) + (beforeAcct - this.data.radacct.length);
    if (removed > 0) {
      this.save();
      console.log(`[RETENTION] ${removed} suresi gecmis kayit temizlendi.`);
    }
    return removed;
  }
}

module.exports = new Database();
