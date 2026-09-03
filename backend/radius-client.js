/*
  =============================================================================
  Yazılım RADIUS İstemcisi (radius-client.js)
  =============================================================================
  Gerçek bir NAS'ın (pfSense / MikroTik / ESP32 köprüsü) yapacağı işi yazılımda
  taklit eder: yerel FreeRADIUS-benzeri sunucumuza (radius-server.js) gerçek
  UDP RADIUS paketleri gönderir.

  Böylece SIM_MODE'da fiziksel donanım olmadan da:
    - Access-Request  -> Access-Accept/Reject (kimlik doğrulama katmanı)
    - Accounting Start -> radacct oturumu açılır (5651 bağlantı başlangıcı)
    - Accounting Stop  -> oturum kapanır (bağlantı bitişi, harcanan bayt)
  gerçek protokol seviyesinde test edilir. Wireshark ile 1812/1813 portlarında
  bu paketleri gözlemleyebilirsiniz.
*/

const dgram = require('dgram');
const radius = require('radius');
const config = require('./config');

const HOST = config.radius.serverHost;
const AUTH_PORT = config.radius.authPort;
const ACCT_PORT = config.radius.acctPort;
const SECRET = config.radius.secret;

// F-10: NAS'ın kendi oturum tablosu. Gerçek bir NAS da bunu tutar; CoA/DM
// (Disconnect-Request) geldiğinde hangi oturumu düşüreceğini buradan bilir.
const activeSessions = new Map();   // sessionId -> { mac, ip }

/**
 * Bir RADIUS paketi gönderir ve yanıtı bekler (timeout'lu).
 */
function sendPacket(port, packet, { expectResponse = true, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (_) {}
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(expectResponse ? reject : resolve,
        expectResponse ? new Error('RADIUS yanıt zaman aşımı') : null);
    }, timeoutMs);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      try {
        const response = radius.decode({ packet: msg, secret: SECRET });
        finish(resolve, response);
      } catch (err) {
        finish(reject, err);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });

    socket.send(packet, 0, packet.length, port, HOST, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(reject, err);
      }
    });
  });
}

/**
 * Access-Request gönderir. Kullanıcı adı = MAC, parola = doğrulama sırasında üretilen
 * rastgele oturum sırrı (F-04: parola artık MAC DEĞİL — MAC taklidiyle oturum devralınamaz).
 * @param {string} mac
 * @param {string} password  db.verifyGuestFlow'un döndürdüğü sessionSecret
 * @returns {Promise<{accepted:boolean, attributes:object}>}
 */
async function authenticate(mac, password) {
  const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  const packet = radius.encode({
    code: 'Access-Request',
    secret: SECRET,
    identifier: Math.floor(Math.random() * 256),
    attributes: {
      'User-Name': cleanMac,
      'User-Password': password || cleanMac,
      'Calling-Station-Id': mac,
      'NAS-Identifier': 'sim-nas',
    },
  });

  const response = await sendPacket(AUTH_PORT, packet);
  return {
    accepted: response.code === 'Access-Accept',
    code: response.code,
    attributes: response.attributes,
  };
}

/**
 * Accounting-Start gönderir (oturum açılışı / bağlantı başlangıcı).
 */
async function accountingStart(mac, ip, sessionId) {
  const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  const packet = radius.encode({
    code: 'Accounting-Request',
    secret: SECRET,
    identifier: Math.floor(Math.random() * 256),
    attributes: {
      'Acct-Status-Type': 'Start',
      'Acct-Session-Id': sessionId,
      'User-Name': cleanMac,
      'Framed-IP-Address': ip,
      'Calling-Station-Id': mac,
    },
  });
  await sendPacket(ACCT_PORT, packet);
  activeSessions.set(sessionId, { mac: cleanMac, ip });
  return { sessionId, ip };
}

/**
 * Accounting-Interim-Update: oturum sürerken harcanan bayt bilgisini günceller.
 */
async function accountingUpdate(mac, sessionId, inputOctets, outputOctets) {
  const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  const packet = radius.encode({
    code: 'Accounting-Request',
    secret: SECRET,
    identifier: Math.floor(Math.random() * 256),
    attributes: {
      'Acct-Status-Type': 'Interim-Update',
      'Acct-Session-Id': sessionId,
      'User-Name': cleanMac,
      'Acct-Input-Octets': inputOctets,
      'Acct-Output-Octets': outputOctets,
    },
  });
  await sendPacket(ACCT_PORT, packet);
}

/**
 * Accounting-Stop gönderir (oturum kapanışı / bağlantı bitişi).
 */
async function accountingStop(mac, sessionId, inputOctets, outputOctets) {
  const cleanMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  const packet = radius.encode({
    code: 'Accounting-Request',
    secret: SECRET,
    identifier: Math.floor(Math.random() * 256),
    attributes: {
      'Acct-Status-Type': 'Stop',
      'Acct-Session-Id': sessionId,
      'User-Name': cleanMac,
      'Acct-Input-Octets': inputOctets,
      'Acct-Output-Octets': outputOctets,
    },
  });
  await sendPacket(ACCT_PORT, packet);
  activeSessions.delete(sessionId);
}

/**
 * F-10: NAS tarafının CoA/DM dinleyicisi (RFC 5176).
 *
 * Gerçek sahada bu, pfSense/MikroTik'in 3799 portudur: RADIUS sunucusu kotayı
 * aşan kullanıcı için Disconnect-Request gönderir, NAS kullanıcıyı ağdan atıp
 * Disconnect-ACK döner. Simülasyonda NAS'ı biz taklit ettiğimiz için dinleyici
 * burada. Bilinmeyen oturum için RFC gereği Disconnect-NAK döneriz.
 *
 * @param {(info:{sessionId:string, mac:string, ip:string}) => void} [onDisconnect]
 * @returns {import('dgram').Socket}
 */
function startCoaListener(onDisconnect) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    let packet;
    try {
      packet = radius.decode({ packet: msg, secret: SECRET });
    } catch (err) {
      return console.error('[NAS-CoA] Paket cozulemedi:', err.message);
    }
    if (packet.code !== 'Disconnect-Request') return;

    const sessionId = packet.attributes['Acct-Session-Id'];
    const username = packet.attributes['User-Name'];
    const session = activeSessions.get(sessionId);

    let code = 'Disconnect-NAK';
    if (session) {
      activeSessions.delete(sessionId);
      code = 'Disconnect-ACK';
      console.log(`[NAS-CoA] Disconnect-Request alindi — ${username} (${session.ip}) agdan dusuruldu. Oturum: ${sessionId}`);
      if (onDisconnect) {
        try { onDisconnect({ sessionId, mac: session.mac, ip: session.ip }); } catch (_) {}
      }
    } else {
      console.warn(`[NAS-CoA] Bilinmeyen oturum icin Disconnect-Request: ${sessionId} -> NAK`);
    }

    const response = radius.encode_response({ packet, code, secret: SECRET });
    socket.send(response, 0, response.length, rinfo.port, rinfo.address);
  });

  socket.on('listening', () => {
    const a = socket.address();
    console.log(`[NAS-CoA] Yazilim NAS, CoA/DM icin dinliyor: ${a.address}:${a.port} (RFC 5176)`);
  });

  socket.on('error', (err) => console.error('[NAS-CoA] Soket hatasi:', err.message));

  socket.bind(config.quota.coaPort);
  return socket;
}

module.exports = {
  authenticate,
  accountingStart,
  accountingUpdate,
  accountingStop,
  startCoaListener,
  activeSessions,
};
