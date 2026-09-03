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
}

module.exports = {
  authenticate,
  accountingStart,
  accountingUpdate,
  accountingStop,
};
