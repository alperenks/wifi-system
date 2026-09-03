/*
  =============================================================================
  Birim testleri — netgsm.js  (G6)
  =============================================================================
  Kapsam: SIM_MODE'da ağa ÇIKMAMA garantisi, OTP mesajının içeriği, NetGSM XML
  gövdesinin doğru kurulması, yanıt kodlarının yorumlanması ve ağ hatasında
  çökmeden hata döndürme.

  ÖNEMLİ: Bu test HİÇBİR koşulda gerçek NetGSM'e istek atmaz — axios.post
  daha ilk satırda sahte bir fonksiyonla değiştirilir ve her çağrı kaydedilir.
  Kimlik bilgileri de sahtedir (gerçek .env okunmaz, değerler elle atanır).
*/

const test = require('node:test');
const assert = require('node:assert');

// 1) Ağ katmanını kapat: gerçek axios.post ASLA çağrılmasın.
const axios = require('axios');
const cagrilar = [];
let sahteYanit = { data: '00 987654321' };
let sahteHata = null;

axios.post = async (url, body, opts) => {
  cagrilar.push({ url, body, opts });
  if (sahteHata) throw sahteHata;
  return sahteYanit;
};

process.env.SIM_MODE = 'true';

const config = require('../config');
const { sendOtpSms, buildOtpXml, interpretResponse, OTP_ENDPOINT } = require('../netgsm');

// Gerçek moda geçmek için config nesnesini geçici olarak değiştiririz.
function sahaModunda(fn) {
  const yedek = {
    SIM_MODE: config.SIM_MODE,
    username: config.netgsm.username,
    password: config.netgsm.password,
    header: config.netgsm.header,
  };
  config.SIM_MODE = false;
  config.netgsm.username = 'sahte-kullanici';
  config.netgsm.password = 'sahte-parola';
  config.netgsm.header = 'TEST_BASLIK';
  try {
    return fn();
  } finally {
    config.SIM_MODE = yedek.SIM_MODE;
    config.netgsm.username = yedek.username;
    config.netgsm.password = yedek.password;
    config.netgsm.header = yedek.header;
  }
}

test.beforeEach(() => {
  cagrilar.length = 0;
  sahteHata = null;
  sahteYanit = { data: '00 987654321' };
});

// --- SIM_MODE: ağa çıkma yok --------------------------------------------------

test('SIM_MODE\'da gercek SMS gonderilmez, ag istegi yapilmaz', async () => {
  const sonuc = await sendOtpSms('5551112233', '123456');

  assert.strictEqual(sonuc.success, true);
  assert.strictEqual(sonuc.simulated, true);
  assert.strictEqual(sonuc.reason, 'SIM_MODE aktif');
  assert.strictEqual(cagrilar.length, 0, 'HICBIR HTTP istegi olmamali');
});

test('simulasyon mesaji OTP kodunu ve uyari metnini icerir', async () => {
  const sonuc = await sendOtpSms('5551112233', '654321');

  assert.match(sonuc.message, /654321/);
  assert.match(sonuc.message, /paylasmayin/i, 'kodun paylasilmamasi uyarisi olmali');
});

test('kimlik bilgileri eksikse saha modunda bile ag istegi yapilmaz', async () => {
  const yedekSim = config.SIM_MODE;
  const yedekUser = config.netgsm.username;
  config.SIM_MODE = false;
  config.netgsm.username = '';        // eksik kimlik

  try {
    const sonuc = await sendOtpSms('5551112233', '123456');
    assert.strictEqual(sonuc.simulated, true);
    assert.strictEqual(sonuc.reason, 'NetGSM kimlik bilgileri boş');
    assert.strictEqual(cagrilar.length, 0);
  } finally {
    config.SIM_MODE = yedekSim;
    config.netgsm.username = yedekUser;
  }
});

// --- XML gövdesi -------------------------------------------------------------

test('buildOtpXml zorunlu alanlari dogru yerlestirir', () => {
  const xml = buildOtpXml({
    usercode: 'kullanici', password: 'parola', header: 'BASLIK',
    message: 'dogrulama kodunuz: 123456', phone: '5551112233',
  });

  assert.match(xml, /<usercode>kullanici<\/usercode>/);
  assert.match(xml, /<password>parola<\/password>/);
  assert.match(xml, /<msgheader>BASLIK<\/msgheader>/);
  assert.match(xml, /<no>5551112233<\/no>/);
  assert.match(xml, /<!\[CDATA\[dogrulama kodunuz: 123456\]\]>/, 'mesaj CDATA icinde olmali');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

test('Turkce karakterli mesaj CDATA sayesinde bozulmadan gecer', () => {
  const xml = buildOtpXml({
    usercode: 'u', password: 'p', header: 'h',
    message: 'Şifreniz: 123456 — çğüöı', phone: '5551112233',
  });

  assert.match(xml, /<!\[CDATA\[Şifreniz: 123456 — çğüöı\]\]>/);
});

test('saha modunda POST dogru uca, XML govdesiyle gider', async () => {
  await sahaModunda(() => sendOtpSms('5559998877', '111222'));

  assert.strictEqual(cagrilar.length, 1);
  const { url, body, opts } = cagrilar[0];

  assert.strictEqual(url, OTP_ENDPOINT);
  assert.match(url, /^https:\/\//, 'HTTPS olmali');
  assert.match(opts.headers['Content-Type'], /application\/xml/);
  assert.ok(opts.timeout > 0, 'zaman asimi tanimli olmali');

  assert.match(body, /<usercode>sahte-kullanici<\/usercode>/);
  assert.match(body, /<no>5559998877<\/no>/);
  assert.match(body, /111222/, 'OTP mesajda olmali');
});

// --- Yanıt yorumlama ---------------------------------------------------------

test('basarili kodlar job id ile birlikte cozulur', () => {
  for (const kod of ['00', '01', '02', '0']) {
    const sonuc = interpretResponse(`${kod} 123456789`);
    assert.strictEqual(sonuc.success, true, `kod ${kod} basarili sayilmali`);
    assert.strictEqual(sonuc.code, kod);
    assert.strictEqual(sonuc.jobId, '123456789');
  }
});

test('hata kodlari anlasilir Turkce mesaja cevrilir', () => {
  const otuz = interpretResponse('30');
  assert.strictEqual(otuz.success, false);
  assert.match(otuz.error, /kullanıcı adı|şifre/i);

  const kirk = interpretResponse('40');
  assert.match(kirk.error, /msgheader/i);   // 'Mesaj başlığı (msgheader) ... onaylı değil'

  const bilinmeyen = interpretResponse('99 tuhaf yanit');
  assert.strictEqual(bilinmeyen.success, false);
  assert.match(bilinmeyen.error, /Bilinmeyen/);
});

test('bosluklu/kirli yanit da dogru yorumlanir', () => {
  const sonuc = interpretResponse('  00   555  \n');
  assert.strictEqual(sonuc.success, true);
  assert.strictEqual(sonuc.jobId, '555');
});

test('saha modunda basarili yanit sonuca yansir', async () => {
  sahteYanit = { data: '00 42424242' };
  const sonuc = await sahaModunda(() => sendOtpSms('5559998877', '111222'));

  assert.strictEqual(sonuc.success, true);
  assert.strictEqual(sonuc.simulated, false);
  assert.strictEqual(sonuc.jobId, '42424242');
});

test('saha modunda reddedilen gonderim hata olarak doner', async () => {
  sahteYanit = { data: '30' };
  const sonuc = await sahaModunda(() => sendOtpSms('5559998877', '111222'));

  assert.strictEqual(sonuc.success, false);
  assert.strictEqual(sonuc.code, '30');
  assert.ok(sonuc.error);
});

// --- Ağ hatası ---------------------------------------------------------------

test('ag hatasinda cokmez, aciklamali hata doner', async () => {
  sahteHata = new Error('ECONNREFUSED');
  const sonuc = await sahaModunda(() => sendOtpSms('5559998877', '111222'));

  assert.strictEqual(sonuc.success, false);
  assert.strictEqual(sonuc.simulated, false);
  assert.match(sonuc.error, /Ağ hatası/);
  assert.match(sonuc.error, /ECONNREFUSED/);
});
