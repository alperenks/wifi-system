/*
  =============================================================================
  Uçtan Uca Demo Sürücüsü (simulate.js)
  =============================================================================
  Çalışan sunucuya (npm start) karşı, hiç donanım olmadan gerçekçi bir
  misafir kalabalığı simüle eder. Müşteri sunumunda ekranı canlandırmak için
  veya sistemi tek komutla test etmek için idealdir.

  Kullanım:
    node server.js          # 1. terminalde sunucuyu başlatın
    npm run simulate        # 2. terminalde bu script'i çalıştırın
    npm run simulate 8 3    # 8 misafir, her biri 3 tur gezinsin

  Not: Node 18+ yerleşik global fetch kullanır (ek bağımlılık yok).
*/

const config = require('./config');

const BASE = `http://localhost:${config.PORT}`;
const GUEST_COUNT = parseInt(process.argv[2] || '5', 10);
const BROWSE_ROUNDS = parseInt(process.argv[3] || '2', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// F-12: /api/sim/* artık yönetici oturumu gerektiriyor. Login olup çerezi taşıyoruz.
let sessionCookie = '';

async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: process.env.ADMIN_USER || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123',
    }),
  });
  if (res.status === 429) {
    // H3: En sık sebep budur — `npm run attack` A7 senaryosu 5 kez yanlış parola
    // deneyip giriş limitini doldurur; limit BELLEKTE tutulduğu için sunucuyu
    // yeniden başlatmak sorunu anında çözer.
    throw new Error('Yönetici giriş limiti dolu (15 dk). Büyük ihtimalle az önce "npm run attack" çalıştı; '
      + 'limit bellekte tutulur — sunucuyu yeniden başlatıp tekrar deneyin.');
  }
  if (!res.ok) {
    throw new Error('Yönetici girişi başarısız — .env ADMIN_USER/ADMIN_PASSWORD kontrol edin (SIM varsayılanı admin/admin123).');
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function line(char = '─', n = 64) { return char.repeat(n); }

async function main() {
  console.log('\n' + line('='));
  console.log(`  5651 CAPTIVE PORTAL — UÇTAN UCA SİMÜLASYON`);
  console.log(`  Hedef: ${BASE}  |  Misafir: ${GUEST_COUNT}  |  Gezinme turu: ${BROWSE_ROUNDS}`);
  console.log(line('=') + '\n');

  // Sunucu ayakta mı?
  try {
    const cfg = await (await fetch(BASE + '/api/config')).json();
    if (!cfg.simMode) {
      console.error('⚠  Sunucu SIM_MODE=false ile çalışıyor. Simülasyon uçları kapalı. .env içinde SIM_MODE=true yapın.');
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    console.error(`✖  Sunucuya ulaşılamadı (${BASE}). Önce "npm start" ile sunucuyu başlatın.`);
    process.exitCode = 1;
    return;
  }

  // Yönetici girişi (sim uçları korumalı)
  try {
    await login();
    console.log('▶  Yönetici oturumu açıldı (simülasyon uçlarına erişim için).\n');
  } catch (e) {
    console.error(`✖  ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const guests = [];

  // 1) Misafirleri bağla
  console.log('▶  Misafirler ağa bağlanıyor (telefon → OTP → doğrulama → RADIUS oturumu)...\n');
  for (let i = 0; i < GUEST_COUNT; i++) {
    const g = await post('/api/sim/full-guest', {});
    if (g.success) {
      guests.push(g);
      console.log(`   ✔ Misafir ${i + 1}: +90 ${g.phone}  |  ${g.ip}  |  MAC ${g.mac}`);
    } else {
      console.log(`   ✖ Misafir ${i + 1} bağlanamadı: ${g.message || 'bilinmeyen hata'}`);
    }
    await sleep(150);
  }

  // 2) Gezinme trafiği üret
  console.log(`\n▶  Gezinme trafiği üretiliyor (${BROWSE_ROUNDS} tur)...\n`);
  for (let round = 1; round <= BROWSE_ROUNDS; round++) {
    for (const g of guests) {
      const r = await post('/api/sim/browse', { ip: g.ip, count: 3 + Math.floor(Math.random() * 4) });
      if (r.success) {
        console.log(`   🌐 [tur ${round}] ${g.ip} → ${r.visited.join(', ')}`);
      }
      await sleep(120);
    }
  }

  // 3) Bazı misafirler ayrılsın (oturum bitişi)
  const leaving = guests.slice(0, Math.floor(guests.length / 3));
  if (leaving.length) {
    console.log(`\n▶  ${leaving.length} misafir ağdan ayrılıyor (RADIUS Accounting-Stop)...\n`);
    for (const g of leaving) {
      await post('/api/sim/disconnect', { ip: g.ip });
      console.log(`   ⏹ ${g.ip} (+90 ${g.phone}) bağlantısı kapatıldı.`);
      await sleep(120);
    }
  }

  console.log('\n' + line('='));
  console.log('  ✅ Simülasyon tamamlandı.');
  console.log(`     • Panelde izleyin : ${BASE}/dashboard`);
  console.log(`     • 5651 log dosyası: backend/logs/5651_captive/<bugün>.log`);
  console.log('     • "Bugünün Günlüğünü Mühürle" ile zaman damgası (.ts) üretin.');
  console.log(line('=') + '\n');
}

// H2: process.exit() yerine exitCode — Windows'ta bekleyen fetch keep-alive
// soketleri varken zorla çıkmak libuv'u düşürüyor ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)") ve gerçek hata mesajı kayboluyor.
// Aynı yaklaşım esp32-hw-test.js'te de kullanılıyor.
main().catch((e) => { console.error('Simülasyon hatası:', e); process.exitCode = 1; });
