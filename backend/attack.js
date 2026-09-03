/*
  =============================================================================
  attack.js — Güvenlik Regresyon / Kötüye Kullanım Test Sürücüsü
  =============================================================================
  Çalışan sunucuya karşı, GUVENLIK-DEGERLENDIRMESI.md'de listelenen açıkları
  sırayla dener. Her saldırı için beklenen "düzeltme sonrası" davranış tanımlıdır.

  Kullanım:
    node server.js        # 1. terminal
    npm run attack        # 2. terminal

  Düzeltmelerden ÖNCE: çoğu satır "GEÇTİ (açık var)" verir  -> docs/attack-before.txt
  Düzeltmelerden SONRA: tüm satırlar "ENGELLENDİ" olmalı     -> docs/attack-after.txt

  Not: Bu betik saldırganı taklit eder; yalnızca yerel/izinli test içindir.
*/

const crypto = require('crypto');
const config = require('./config');
const radiusClient = require('./radius-client');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BASE = `http://localhost:${config.PORT}`;

// H3: A7 (giris kaba kuvveti) 5 yanlis parola deneyip giris limitini doldurur;
// sonrasinda simulate/panel 15 dk giris yapamaz. --skip-a7 ile atlanabilir.
const SKIP_A7 = process.argv.includes('--skip-a7');
const line = (c = '─', n = 66) => c.repeat(n);

let passVuln = 0;   // açık hâlâ açık (kötü)
let blocked = 0;    // saldırı engellendi (iyi)
const rows = [];

function record(id, title, outcome, detail) {
  // outcome: 'BLOCKED' | 'VULN' | 'INFO'
  if (outcome === 'BLOCKED') blocked++;
  else if (outcome === 'VULN') passVuln++;
  rows.push({ id, title, outcome, detail });
  const tag = outcome === 'BLOCKED' ? 'ENGELLENDI     '
            : outcome === 'VULN'    ? 'GECTI(acik var)'
            :                          'BILGI          ';
  console.log(`  [${id}] ${tag} ${title}`);
  if (detail) console.log(`        -> ${detail}`);
}

async function req(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json, headers: res.headers };
}

function randomMac() {
  const h = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${h()}:${h()}:${h()}:${h()}:${h()}:${h()}`;
}

function randomPhone() {
  return '5' + Math.floor(300000000 + Math.random() * 600000000);
}

// --- A1: OTP kaba kuvvet -----------------------------------------------------
async function a1() {
  const mac = randomMac();
  const phone = randomPhone();
  const send = await req('/api/send-otp', { method: 'POST', body: { mac, phone } });
  if (send.status !== 200) {
    return record('A1', 'OTP kaba kuvvet', 'INFO',
      `OTP istenemedi (status ${send.status}); onceki limit tetiklenmis olabilir.`);
  }
  // Simülasyonda gerçek kod yanıtta gelir; onu bilerek KULLANMIYORUZ (saldırgan bilmez).
  // Açığın özü "deneme sınırı yok" — kanıt, kilitlenmeden sınırsız deneme yapabilmek.
  // 6 haneli kod = 1.000.000 olasılık; gerçekten kırmayı denemek yerine, kaç yanlış
  // denemeden sonra sistemin bizi kilitlediğini ölçüyoruz.
  const BUDGET = 300;
  let accepted = false, lockedAt = null, tried = 0;
  for (let i = 0; i < BUDGET; i++) {
    const guess = String(100000 + i);            // sıralı deneme (kod rastgele, bulunması beklenmez)
    const v = await req('/api/verify-otp', { method: 'POST', body: { mac, otp: guess } });
    tried++;
    if (v.status === 200 && v.json && v.json.success) { accepted = true; break; }
    if (v.status === 429) { lockedAt = tried; break; }
  }
  if (accepted) record('A1', 'OTP kaba kuvvet', 'VULN', 'Kod deneyerek dogrulama asildi.');
  else if (lockedAt !== null) record('A1', 'OTP kaba kuvvet', 'BLOCKED',
      `${lockedAt}. yanlis denemede akis kilitlendi (429) — sinirsiz deneme engellendi.`);
  else record('A1', 'OTP kaba kuvvet', 'VULN',
      `${tried} yanlis deneme yapildi ve sistem hic kilitlemedi — sinirsiz kaba kuvvet mumkun.`);
}

// --- A2: SMS bombalama (MAC değiştirerek limit atlama) ------------------------
async function a2() {
  const phone = randomPhone();
  let sent = 0, firstBlockAt = null;
  for (let i = 0; i < 20; i++) {
    const r = await req('/api/send-otp', { method: 'POST', body: { mac: randomMac(), phone } });
    if (r.status === 200) sent++;
    else if (r.status === 429 && firstBlockAt === null) { firstBlockAt = i + 1; break; }
  }
  if (sent >= 5) record('A2', 'SMS bombalama (MAC rotasyonu)', 'VULN',
      `${sent} SMS tetiklendi — MAC degistirerek limit asildi.`);
  else record('A2', 'SMS bombalama (MAC rotasyonu)', 'BLOCKED',
      `${firstBlockAt}. istekte 429 — telefon basina limit tuttu (toplam ${sent} gecti).`);
}

// --- A3: Kimlik doğrulamasız log silme --------------------------------------
async function a3() {
  const r = await req('/api/dashboard/clear-logs', { method: 'POST', body: {} });
  if (r.status === 200) record('A3', 'Cerezsiz log silme', 'VULN',
      '5651 delil dosyalari kimlik dogrulamasiz silinebildi!');
  else if (r.status === 401 || r.status === 403) record('A3', 'Cerezsiz log silme', 'BLOCKED',
      `Erisim reddedildi (${r.status}).`);
  else record('A3', 'Cerezsiz log silme', 'BLOCKED', `Beklenmeyen status ${r.status} (silme gerceklesmedi).`);
}

// --- A4: Kimlik doğrulamasız geçmiş sorgusu ---------------------------------
async function a4() {
  const r = await req('/api/dashboard/search?q=5');
  if (r.status === 200 && r.json && Array.isArray(r.json.matches)) {
    record('A4', 'Cerezsiz gecmis sorgusu', 'VULN',
      `Telefon/MAC gecmisi kimlik dogrulamasiz sorgulandi (${r.json.matches.length} kayit dondu).`);
  } else if (r.status === 401 || r.status === 403) {
    record('A4', 'Cerezsiz gecmis sorgusu', 'BLOCKED', `Erisim reddedildi (${r.status}).`);
  } else {
    record('A4', 'Cerezsiz gecmis sorgusu', 'BLOCKED', `Status ${r.status}.`);
  }
}

// --- A5: ESP32 imzasız yetkilendirme ----------------------------------------
// ESP32 ağ testi yalnızca ESP32_AP_URL tanımlıysa yapılır.
async function a5() {
  const url = config.esp32 && config.esp32.apUrl;
  if (!url) {
    record('A5', 'ESP32 imzasiz yetkilendirme', 'INFO',
      'ESP32_AP_URL bos — ag testi atlandi. Backend imza uretimi Adim 5 sonrasi yerelde dogrulanir.');
    return;
  }
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/authorize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: randomMac(), ts: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(8).toString('hex') }),
    });
    if (r.status === 401 || r.status === 403) record('A5', 'ESP32 imzasiz yetkilendirme', 'BLOCKED', `ESP32 reddetti (${r.status}).`);
    else record('A5', 'ESP32 imzasiz yetkilendirme', 'VULN', `Imzasiz istek kabul edildi (${r.status}).`);
  } catch (e) {
    record('A5', 'ESP32 imzasiz yetkilendirme', 'INFO', `ESP32 erisilemedi: ${e.message}`);
  }
}

// --- A8: Veri kotasını aşıp sınırsız kullanmaya devam etme (F-10) -----------
// Kota açıkken, eşiği aşan bir oturumun GERÇEKTEN kapatıldığını doğrular.
// Kota kapalıysa (QUOTA_MB=0, varsayılan) senaryo atlanır.
async function a8() {
  // Kota ayarını SUNUCUDAN sor — betiğin kendi .env'i sunucununkiyle aynı olmayabilir.
  const cfg = await req('/api/config');
  const kotaMb = cfg.json && Number(cfg.json.quotaMb);
  if (!kotaMb || kotaMb <= 0) {
    return record('A8', 'Veri kotasi asimi', 'INFO',
      'Sunucuda kota kapali (QUOTA_MB=0) — senaryo atlandi. Denemek icin: QUOTA_MB=2 node server.js');
  }

  // Oturum durumunu okuyabilmek için yönetici girişi (SIM demosu varsayılanı).
  const parola = config.admin.devPasswordPlain;
  if (!parola) {
    return record('A8', 'Veri kotasi asimi', 'INFO',
      'Yonetici parolasi bilinmiyor (ADMIN_PASSWORD_HASH ayarli) — senaryo atlandi.');
  }
  const giris = await req('/api/auth/login', { method: 'POST', body: { user: config.admin.user, password: parola } });
  if (giris.status === 429) {
    // F6: Onceki kosunun A7 kaba kuvvet denemeleri limiti doldurmus olabilir.
    return record('A8', 'Veri kotasi asimi', 'INFO',
      'Yonetici giris limiti dolu (onceki A7 kosusundan kalan basarisiz denemeler). ' +
      'Sunucuyu yeniden baslatip tekrar calistirin — limit bellekte tutulur.');
  }
  if (giris.status !== 200) {
    return record('A8', 'Veri kotasi asimi', 'INFO',
      `Yonetici girisi yapilamadi (${giris.status}) — senaryo atlandi.`);
  }
  const cookie = (giris.headers.get('set-cookie') || '').split(';')[0];

  // 1) Sanal misafir bağlanır (gerçek RADIUS oturumu açılır)
  const misafir = await req('/api/sim/full-guest', { method: 'POST', body: {}, cookie });
  if (misafir.status !== 200 || !misafir.json || !misafir.json.success) {
    return record('A8', 'Veri kotasi asimi', 'INFO',
      `Sanal misafir olusturulamadi (${misafir.status}) — senaryo atlandi.`);
  }
  const { mac, ip, sessionId } = misafir.json;

  // 2) Saldırı: kotanın çok üstünde veri harcandığını bildir ve kullanmaya devam et
  const asiriBayt = Math.ceil(kotaMb * 1024 * 1024 * 1.5);
  try {
    await radiusClient.accountingUpdate(mac, sessionId, asiriBayt, asiriBayt);
  } catch (e) {
    return record('A8', 'Veri kotasi asimi', 'INFO', `Accounting paketi gonderilemedi: ${e.message}`);
  }

  // 3) Sunucu oturumu kapatmalı (CoA/Disconnect + accounting kaydı)
  let oturum = null;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    const r = await req('/api/dashboard/sessions', { cookie });
    if (r.status === 200 && Array.isArray(r.json)) {
      oturum = r.json.find(o => o.sessionId === sessionId);
      if (oturum && !oturum.active) break;
    }
  }

  if (!oturum) {
    record('A8', 'Veri kotasi asimi', 'INFO', 'Oturum kaydi okunamadi — sonuc belirsiz.');
  } else if (oturum.active) {
    record('A8', 'Veri kotasi asimi', 'VULN',
      `${(asiriBayt * 2 / 1048576).toFixed(1)} MB harcandi ama oturum HALA ACIK — kota uygulanmiyor.`);
  } else {
    record('A8', 'Veri kotasi asimi', 'BLOCKED',
      `Kota (${kotaMb} MB) asilinca oturum kapatildi (sebep: ${oturum.terminateCause || 'bilinmiyor'}).`);
  }
}

// --- A7: Yönetici girişi kaba kuvvet ----------------------------------------
async function a7() {
  let ok = false, blockAt = null;
  for (let i = 0; i < 20; i++) {
    const r = await req('/api/auth/login', { method: 'POST', body: { user: 'admin', password: 'yanlis' + i } });
    if (r.status === 200) { ok = true; break; }
    if (r.status === 429) { blockAt = i + 1; break; }
    if (r.status === 404) {
      return record('A7', 'Yonetici girisi kaba kuvvet', 'INFO', 'Login uc noktasi henuz yok (F-12 uygulanmadan once normal).');
    }
  }
  if (ok) record('A7', 'Yonetici girisi kaba kuvvet', 'VULN', 'Yanlis parola kabul edildi!');
  else if (blockAt !== null) record('A7', 'Yonetici girisi kaba kuvvet', 'BLOCKED', `${blockAt}. denemede 429.`);
  else record('A7', 'Yonetici girisi kaba kuvvet', 'BLOCKED', '20 yanlis deneme reddedildi.');
}

async function main() {
  console.log('\n' + line('='));
  console.log('  wifi-system — GUVENLIK SALDIRI TESTI');
  console.log(`  Hedef: ${BASE}   Tarih: ${new Date().toLocaleString()}`);
  console.log(line('=') + '\n');
  try {
    await a1(); await a2(); await a3(); await a4(); await a5(); await a8();
    if (SKIP_A7) {
      record('A7', 'Yonetici girisi kaba kuvvet', 'INFO', '--skip-a7 verildi, senaryo atlandi.');
    } else {
      await a7();
    }
  } catch (e) {
    console.error('\n  Test surucusu hata verdi (sunucu calisiyor mu?):', e.message);
    process.exitCode = 2;
    return;
  }
  console.log('\n' + line('─'));
  console.log(`  OZET:  ${blocked} engellendi   ${passVuln} acik hala mevcut`);
  console.log(line('─'));
  if (!SKIP_A7) {
    console.log('  NOT: A7 senaryosu yonetici giris limitini doldurdu. Simdi "npm run simulate"');
    console.log('       veya panel girisi 15 dk 429 alir — sunucuyu yeniden baslatin ya da');
    console.log('       bir dahaki sefere "npm run attack -- --skip-a7" kullanin.\n');
  }

  // H2: exit yerine exitCode — bekleyen keep-alive soketleriyle zorla cikmak
  // Windows'ta libuv'u dusuruyor ve ozet ciktisi kayboluyor.
  if (passVuln > 0) {
    console.log('  ! Acik(lar) mevcut — duzeltme oncesi bekleniyor.\n');
    process.exitCode = 1;
  } else {
    console.log('  + Tum saldirilar engellendi.\n');
    process.exitCode = 0;
  }
}

main();
