const dgram = require('dgram');
const radius = require('radius');
const db = require('./db');
const config = require('./config');

const SHARED_SECRET = config.radius.secret;
const AUTH_PORT = config.radius.authPort;
const ACCT_PORT = config.radius.acctPort;

// F-10: Veri kotası. 0 = kapalı.
const QUOTA_BYTES = Math.max(0, config.quota.megabytes) * 1024 * 1024;

/**
 * F-10: NAS'a RFC 5176 Disconnect-Request (CoA/DM) gönderir.
 *
 * Gerçek sahada bunu FreeRADIUS yapar: kotayı aşan kullanıcının oturumunu
 * NAS'ın (pfSense/MikroTik/ESP32 köprüsü) 3799 numaralı CoA portuna paket
 * göndererek düşürür. Burada aynı paketi gerçekten üretiyoruz — Wireshark'ta
 * görülebilir. NAS ACK dönerse kullanıcı düşürülmüştür.
 *
 * @returns {Promise<{acked:boolean, code?:string, error?:string}>}
 */
function sendDisconnect(username, sessionId, nasAddress) {
  const host = config.quota.coaHost || nasAddress;
  const port = config.quota.coaPort;

  return new Promise((resolve) => {
    let packet;
    try {
      packet = radius.encode({
        code: 'Disconnect-Request',
        secret: SHARED_SECRET,
        identifier: Math.floor(Math.random() * 256),
        attributes: {
          'User-Name': username,
          'Acct-Session-Id': sessionId,
          'Acct-Terminate-Cause': 'Session-Timeout',   // kota bitti -> oturum sonlandırıldı
        },
      });
    } catch (err) {
      return resolve({ acked: false, error: err.message });
    }

    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ acked: false, error: 'CoA yanıt zaman aşımı' }), 2000);

    socket.on('message', (msg) => {
      try {
        const response = radius.decode({ packet: msg, secret: SHARED_SECRET });
        finish({ acked: response.code === 'Disconnect-ACK', code: response.code });
      } catch (err) {
        finish({ acked: false, error: err.message });
      }
    });
    socket.on('error', (err) => finish({ acked: false, error: err.message }));

    socket.send(packet, 0, packet.length, port, host, (err) => {
      if (err) finish({ acked: false, error: err.message });
    });
  });
}

/**
 * F-10: Interim-Update sonrası kota kontrolü. Eşik aşıldıysa oturumu kapatır
 * ve NAS'a Disconnect-Request gönderir.
 */
const QUOTA_WARN_RATIO = 0.8;   // H5: bu orana gelince bir kez uyarılır

async function enforceQuota(username, sessionId, inputOctets, outputOctets, nasAddress) {
  if (QUOTA_BYTES <= 0) return false;                       // kota kapalı
  const total = inputOctets + outputOctets;

  const session = db.data.radacct.find(s => s.sessionId === sessionId && s.active);
  if (!session) return false;                               // zaten kapanmış

  // H5: Eşiğe yaklaşanı önce UYAR. Misafirin birden kopması yerine işletmeci
  // (ve panel) durumu önceden görsün. Oturum başına yalnızca bir kez loglanır.
  if (total >= QUOTA_BYTES * QUOTA_WARN_RATIO && total < QUOTA_BYTES) {
    if (!session.quotaWarned) {
      session.quotaWarned = true;
      db.save();
      const yuzde = Math.round((total / QUOTA_BYTES) * 100);
      console.warn(`[QUOTA] ${username} kotasinin %${yuzde}'ini kullandi (${(total / 1024 / 1024).toFixed(1)} MB / ${config.quota.megabytes} MB).`);
    }
    return false;
  }

  if (total < QUOTA_BYTES) return false;

  const mb = (total / 1024 / 1024).toFixed(1);
  console.warn(`[QUOTA] ${username} kotayi asti (${mb} MB / ${config.quota.megabytes} MB). Oturum kapatiliyor: ${sessionId}`);

  db.stopSession(sessionId, inputOctets, outputOctets, 'quota');

  const result = await sendDisconnect(username, sessionId, nasAddress);
  if (result.acked) {
    console.log(`[QUOTA] NAS Disconnect-ACK dondu — ${username} agdan dusuruldu.`);
  } else {
    console.warn(`[QUOTA] NAS Disconnect onaylamadi (${result.error || result.code}). Oturum yine de kapatildi (muhasebe kaydi kesin).`);
  }
  return true;
}

function startRadiusServer() {
  const authSocket = dgram.createSocket('udp4');
  const acctSocket = dgram.createSocket('udp4');

  // --- Authentication Socket (UDP 1812) ---
  authSocket.on('message', (msg, rinfo) => {
    try {
      const packet = radius.decode({ packet: msg, secret: SHARED_SECRET });
      
      if (packet.code === 'Access-Request') {
        const username = packet.attributes['User-Name'];
        const password = packet.attributes['User-Password'];
        
        console.log(`[RADIUS-AUTH] Access-Request received. MAC/Username: ${username} from ${rinfo.address}:${rinfo.port}`);

        const checkRecord = db.getRadCheck(username);
        let responseCode = 'Access-Reject';
        let responseAttributes = {};

        if (checkRecord && checkRecord.password === password) {
          responseCode = 'Access-Accept';
          
          // Reply attributes. Only STANDARD RADIUS attributes are encoded here so the
          // response is valid without vendor dictionaries. Rate limit (Mikrotik/WISPr) is
          // a vendor-specific attribute the real NAS reads from its own profile; in this
          // simulation we keep it in radreply and log it rather than encoding it.
          const replyRecord = db.getRadReply(username) || {};
          const rateLimit = replyRecord['Mikrotik-Rate-Limit'] || 'sınırsız';
          responseAttributes = {
            'Session-Timeout': parseInt(replyRecord['Session-Timeout'] || '7200', 10),
            'Acct-Interim-Interval': 300
          };

          console.log(`[RADIUS-AUTH] Access-Accept for MAC: ${username}. Session-Timeout: ${responseAttributes['Session-Timeout']}s, Rate-Limit: ${rateLimit}`);
        } else {
          console.warn(`[RADIUS-AUTH] Access-Reject for MAC: ${username}. User not verified or password mismatch.`);
        }

        const responseMsg = radius.encode_response({
          packet: packet,
          code: responseCode,
          secret: SHARED_SECRET,
          attributes: responseAttributes
        });

        authSocket.send(responseMsg, 0, responseMsg.length, rinfo.port, rinfo.address);
      }
    } catch (err) {
      console.error('[RADIUS-AUTH] Error processing auth packet:', err);
    }
  });

  authSocket.on('listening', () => {
    const address = authSocket.address();
    console.log(`[RADIUS] Auth server listening on ${address.address}:${address.port}`);
  });

  // --- Accounting Socket (UDP 1813) ---
  acctSocket.on('message', (msg, rinfo) => {
    try {
      const packet = radius.decode({ packet: msg, secret: SHARED_SECRET });
      
      if (packet.code === 'Accounting-Request') {
        const username = packet.attributes['User-Name'];
        const sessionId = packet.attributes['Acct-Session-Id'];
        const statusType = packet.attributes['Acct-Status-Type']; // 1 = Start, 2 = Stop, 3 = Interim-Update
        const clientIp = packet.attributes['Framed-IP-Address'];
        
        const inputOctets = parseInt(packet.attributes['Acct-Input-Octets'] || '0', 10);
        const outputOctets = parseInt(packet.attributes['Acct-Output-Octets'] || '0', 10);

        console.log(`[RADIUS-ACCT] Acct-Request received. MAC: ${username}, Session: ${sessionId}, Status: ${statusType}, IP: ${clientIp}`);

        if (statusType === 'Start' || statusType === 1) {
          db.startSession(sessionId, username, clientIp);
          console.log(`[RADIUS-ACCT] Started session for ${username} with IP ${clientIp}`);
        } else if (statusType === 'Stop' || statusType === 2) {
          db.stopSession(sessionId, inputOctets, outputOctets);
          console.log(`[RADIUS-ACCT] Stopped session for ${username}. In/Out: ${inputOctets}/${outputOctets} bytes`);
        } else if (statusType === 'Alive' || statusType === 'Interim-Update' || statusType === 3) {
          db.updateSession(sessionId, inputOctets, outputOctets);
          console.log(`[RADIUS-ACCT] Session update for ${username}. In/Out: ${inputOctets}/${outputOctets} bytes`);
          // F-10: kota kontrolü Accounting-Response'u geciktirmesin — arka planda.
          enforceQuota(username, sessionId, inputOctets, outputOctets, rinfo.address)
            .catch(err => console.error('[QUOTA] Kota uygulanamadi:', err.message));
        }

        const responseMsg = radius.encode_response({
          packet: packet,
          code: 'Accounting-Response',
          secret: SHARED_SECRET
        });

        acctSocket.send(responseMsg, 0, responseMsg.length, rinfo.port, rinfo.address);
      }
    } catch (err) {
      console.error('[RADIUS-ACCT] Error processing acct packet:', err);
    }
  });

  acctSocket.on('listening', () => {
    const address = acctSocket.address();
    console.log(`[RADIUS] Acct server listening on ${address.address}:${address.port}`);
  });

  // Bind to wildcard address
  authSocket.bind(AUTH_PORT);
  acctSocket.bind(ACCT_PORT);

  // Soketleri döndürüyoruz ki testler sunucuyu kapatabilsin (üretimde kullanılmaz).
  return { authSocket, acctSocket };
}

module.exports = { startRadiusServer, sendDisconnect, enforceQuota, QUOTA_BYTES };
