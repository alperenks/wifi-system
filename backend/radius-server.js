const dgram = require('dgram');
const radius = require('radius');
const db = require('./db');
const config = require('./config');

const SHARED_SECRET = config.radius.secret;
const AUTH_PORT = config.radius.authPort;
const ACCT_PORT = config.radius.acctPort;

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
}

module.exports = { startRadiusServer };
