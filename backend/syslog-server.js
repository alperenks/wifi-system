const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SYSLOG_PORT = 514;
const LOGS_DIR = path.join(__dirname, 'logs', '5651_captive');

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function startSyslogServer() {
  const server = dgram.createSocket('udp4');

  server.on('message', (msg, rinfo) => {
    const rawMessage = msg.toString();
    
    // Log the raw message to console for debugging in simulation
    // console.log(`[SYSLOG-RAW] from ${rinfo.address}: ${rawMessage}`);

    parseAndSaveLog(rawMessage, rinfo.address);
  });

  server.on('listening', () => {
    const address = server.address();
    console.log(`[SYSLOG] Syslog receiver listening on ${address.address}:${address.port}`);
  });

  server.bind(SYSLOG_PORT);
}

/**
 * Parses pfSense/MikroTik DNS or NAT filter logs and returns a 5651 log record
 * (or null when the line is not something we must record).
 *
 * SAF FONKSIYON: diske yazmaz. Yazma isi writeTo5651Log'da; bu ayrim sayesinde
 * ayristirici gercek log dosyalarina dokunmadan birim testlerle sinanabilir (G1).
 */
function parseSyslogLine(rawMessage) {
  const now = new Date();
  let logRecord = null;

  if (typeof rawMessage !== 'string' || rawMessage.length === 0) return null;

  // --- 1. pfSense Unbound DNS Log Parser ---
  // Example: <13>Jul  2 05:32:10 unbound[90243]: info: 192.168.20.15 www.google.com. A IN
  if (rawMessage.includes('unbound')) {
    const dnsRegex = /unbound\[\d+\]: info: (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}) ([a-zA-Z0-9.-]+)\. [A-Z]+ IN/;
    const match = rawMessage.match(dnsRegex);
    if (match) {
      const localIp = match[1];
      const domain = match[2];
      const phone = db.getPhoneByIp(localIp);
      const mac = db.macByIp(localIp) || 'UNKNOWN_MAC';

      logRecord = {
        timestamp: now.toISOString(),
        type: 'DNS',
        localIp,
        mac,
        phone,
        destIp: 'DNS_RESOLVER',
        destPort: 53,
        details: `DNS_Query: ${domain}`
      };
    }
  }

  // --- 2. pfSense filterlog (Firewall Connection/NAT Logs) ---
  // Example: filterlog: 5,,,1000000103,em1,match,pass,out,4,0x0,,64,0,0,DF,17,udp,76,192.168.20.15,8.8.8.8,51234,53,56
  else if (rawMessage.includes('filterlog:')) {
    const filterParts = rawMessage.split(',');
    // pfSense filterlog CSV (0-index, "filterlog: " ön ekiyle):
    //   6 action(pass/block), 7 direction(in/out), 8 ip_version(4/6),
    //   16 proto, 18 source IP, 19 dest IP, 20 src port, 21 dest port
    if (filterParts.length >= 22 && filterParts[6] === 'pass' && filterParts[8] === '4') {
      const proto = filterParts[16];
      const localIp = filterParts[18];
      const destIp = filterParts[19];
      const srcPort = filterParts[20];
      const destPort = filterParts[21];

      // We only care about outward connections from the client
      if (localIp.startsWith('192.168.') || localIp.startsWith('10.') || localIp.startsWith('172.')) {
        const phone = db.getPhoneByIp(localIp);
        const mac = db.macByIp(localIp) || 'UNKNOWN_MAC';

        logRecord = {
          timestamp: now.toISOString(),
          type: 'NAT',
          localIp,
          mac,
          phone,
          destIp,
          destPort: parseInt(destPort, 10),
          srcPort: parseInt(srcPort, 10),
          details: `Proto: ${proto.toUpperCase()}`
        };
      }
    }
  }

  // --- 3. MikroTik DNS/Firewall Log Parser (Alternative) ---
  // Example: firewall,info forward: in:bridge-guest out:ether1-wan, src-mac 00:11:22:33:44:55, proto TCP (SYN), 192.168.88.254:50123->142.250.185.78:443, NAT (192.168.88.254:50123->85.100.100.100:50123)->142.250.185.78:443, len 60
  else if (rawMessage.includes('src-mac') || rawMessage.includes('forward:')) {
    const macMatch = rawMessage.match(/src-mac ([0-f]{2}:[0-f]{2}:[0-f]{2}:[0-f]{2}:[0-f]{2}:[0-f]{2})/i);
    const ipMatch = rawMessage.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)->(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/);
    
    if (ipMatch) {
      const localIp = ipMatch[1];
      const srcPort = ipMatch[2];
      const destIp = ipMatch[3];
      const destPort = ipMatch[4];
      const mac = macMatch ? macMatch[1].toLowerCase().replace(/[^a-f0-9]/g, '') : (db.macByIp(localIp) || 'UNKNOWN_MAC');
      const phone = db.getPhoneByMac(mac);

      logRecord = {
        timestamp: now.toISOString(),
        type: 'NAT',
        localIp,
        mac,
        phone,
        destIp,
        destPort: parseInt(destPort, 10),
        srcPort: parseInt(srcPort, 10),
        details: 'MikroTik Firewall Event'
      };
    }
  }

  // --- 4. Simulation / Custom Script Log (for easy manual testing) ---
  // Format: "MOCK_LOG: localIp=192.168.20.15 destIp=142.250.185.78 destPort=443 srcPort=51234 proto=TCP"
  // Format: "MOCK_DNS: localIp=192.168.20.15 domain=youtube.com"
  else if (rawMessage.startsWith('MOCK_')) {
    if (rawMessage.startsWith('MOCK_LOG:')) {
      const localIp = extractParam(rawMessage, 'localIp');
      const destIp = extractParam(rawMessage, 'destIp');
      const destPort = extractParam(rawMessage, 'destPort');
      const srcPort = extractParam(rawMessage, 'srcPort');
      const proto = extractParam(rawMessage, 'proto') || 'TCP';
      const phone = db.getPhoneByIp(localIp);
      const mac = db.macByIp(localIp) || 'UNKNOWN_MAC';

      logRecord = {
        timestamp: now.toISOString(),
        type: 'NAT',
        localIp,
        mac,
        phone,
        destIp,
        destPort: parseInt(destPort, 10),
        srcPort: parseInt(srcPort, 10),
        details: `Simulated connection proto: ${proto}`
      };
    } else if (rawMessage.startsWith('MOCK_DNS:')) {
      const localIp = extractParam(rawMessage, 'localIp');
      const domain = extractParam(rawMessage, 'domain');
      const phone = db.getPhoneByIp(localIp);
      const mac = db.macByIp(localIp) || 'UNKNOWN_MAC';

      logRecord = {
        timestamp: now.toISOString(),
        type: 'DNS',
        localIp,
        mac,
        phone,
        destIp: 'DNS_RESOLVER',
        destPort: 53,
        details: `Simulated DNS: ${domain}`
      };
    }
  }

  return logRecord;
}

/** Ayristir + yaz. Soket katmaninin kullandigi sarmalayici. */
function parseAndSaveLog(rawMessage, senderIp) {
  const logRecord = parseSyslogLine(rawMessage);
  if (logRecord) {
    writeTo5651Log(logRecord);
  }
}

function extractParam(str, param) {
  const match = str.match(new RegExp(`${param}=([^\\s]+)`));
  return match ? match[1] : null;
}

/**
 * 5651 log satirini uretir.
 *
 * DIKKAT: Bu bicim YASAL DELIL bicimidir - alan sirasi/ayirici DEGISTIRILEMEZ.
 * (test/syslog-server.test.js bicimi birebir dogrular; kirilirsa degisiklik
 * kasitli degildir.)
 *   TimeStamp | LogType | MAC | Local IP | Src Port | Dest IP | Dest Port | Phone | Details
 */
// Bir alanın içinde ayraç (|) veya satır sonu OLAMAZ: aksi hâlde tek bir kayıt
// birden fazla satır gibi görünür ve loga sahte delil satırı enjekte edilebilir.
// Savunma derinliği: girdi doğrulaması zaten bunu engelliyor, bu son kapı.
function guvenliAlan(deger) {
  return String(deger == null ? '' : deger).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/');
}

function buildLogLine(record) {
  const a = guvenliAlan;
  return `${a(record.timestamp)} | ${a(record.type)} | ${a(record.mac)} | ${a(record.localIp)} | ` +
    `${a(record.srcPort || 'N/A')} | ${a(record.destIp)} | ${a(record.destPort)} | ${a(record.phone)} | ${a(record.details)}\n`;
}

function writeTo5651Log(record) {
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(LOGS_DIR, `${dateStr}.log`);

  const logLine = buildLogLine(record);

  fs.appendFile(filePath, logLine, 'utf8', (err) => {
    if (err) {
      console.error('[SYSLOG] Failed to write 5651 log line:', err);
    } else {
      // Numara log DOSYASINA tam yazılır (5651 gereği); konsola maskeli düşer.
      const maskeli = String(record.phone || '').length >= 10
        ? `${String(record.phone).slice(0, 1)}** *** ${String(record.phone).slice(-4)}`
        : record.phone;
      console.log(`[5651-LOGGED] Type: ${record.type}, Local: ${record.localIp}, Phone: ${maskeli}, Dest: ${record.destIp}`);
    }
  });
}

module.exports = { startSyslogServer, parseSyslogLine, buildLogLine, LOGS_DIR };
