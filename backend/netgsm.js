/*
  =============================================================================
  NetGSM SMS OTP Entegrasyonu (netgsm.js)
  =============================================================================
  NetGSM, GET metodunu kaldırdığı için tüm istekler HTTPS + POST ile
  https://api.netgsm.com.tr adresine gider (rapordaki 2023 güncellemesi).

  Bu modül OTP (tek kullanımlık şifre) SMS'lerine özel /sms/send/otp XML
  ucunu kullanır. OTP SMS'leri operatör kuyruğunda önceliklidir.

  config.SIM_MODE=true iken ağ isteği YAPILMAZ; fonksiyon "simulated: true"
  döner ve OTP çağıran tarafta konsola/arayüze basılır. Böylece kontör
  harcamadan ve gerçek hat olmadan tüm akış test edilebilir.

  NetGSM yanıt kodları (metnin başındaki sayı):
    00 / 01 / 02  -> Başarılı (job id ile birlikte döner)
    20 -> Mesaj metni/karakter hatası
    30 -> Geçersiz kullanıcı adı, şifre veya API erişim izni yok
    40 -> Mesaj başlığı (header) sistemde tanımlı/onaylı değil
    70 -> Hatalı sorgu / parametre
*/

const axios = require('axios');
const config = require('./config');

const OTP_ENDPOINT = 'https://api.netgsm.com.tr/sms/send/otp';

function buildOtpXml({ usercode, password, header, message, phone }) {
  // CDATA ile Türkçe karakter ve özel karakter güvenliği
  return `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
  <header>
    <usercode>${usercode}</usercode>
    <password>${password}</password>
    <msgheader>${header}</msgheader>
  </header>
  <body>
    <msg><![CDATA[${message}]]></msg>
    <no>${phone}</no>
  </body>
</mainbody>`;
}

function interpretResponse(raw) {
  const text = String(raw).trim();
  const code = text.split(/\s+/)[0];
  const okCodes = ['00', '01', '02', '0'];
  if (okCodes.includes(code)) {
    return { success: true, code, jobId: text.split(/\s+/)[1] || null, raw: text };
  }
  const errors = {
    '20': 'Mesaj metni/karakter sayısı hatalı.',
    '30': 'Geçersiz kullanıcı adı, şifre veya API erişim izni yok.',
    '40': 'Mesaj başlığı (msgheader) NetGSM panelinde onaylı değil.',
    '50': 'Aboneliğiniz İYS kapsamında değil.',
    '51': 'Gönderim şablonu (msgheader) uygun değil.',
    '70': 'Hatalı veya eksik parametre.',
    '85': 'Mükerrer gönderim sınırına takıldınız.',
  };
  return { success: false, code, error: errors[code] || `Bilinmeyen NetGSM hatası (${text})`, raw: text };
}

/**
 * OTP SMS gönderir.
 * @param {string} phone  Başında 0 olmadan 10 hane, örn "5xxxxxxxxx"
 * @param {string} otp    6 haneli kod
 * @returns {Promise<{success:boolean, simulated?:boolean, code?:string, jobId?:string, error?:string, raw?:string}>}
 */
async function sendOtpSms(phone, otp) {
  const message = `${config.netgsm.header || 'Misafir Agi'} dogrulama kodunuz: ${otp}. Kodu kimseyle paylasmayin.`;

  // --- Simülasyon Modu: gerçek SMS gönderme ---
  if (config.SIM_MODE || !config.netgsm.username || !config.netgsm.password) {
    return {
      success: true,
      simulated: true,
      message,
      reason: config.SIM_MODE ? 'SIM_MODE aktif' : 'NetGSM kimlik bilgileri boş',
    };
  }

  // --- Gerçek NetGSM POST ---
  const xml = buildOtpXml({
    usercode: config.netgsm.username,
    password: config.netgsm.password,
    header: config.netgsm.header,
    message,
    phone,
  });

  try {
    const response = await axios.post(OTP_ENDPOINT, xml, {
      headers: { 'Content-Type': 'application/xml; charset=UTF-8' },
      timeout: 10000,
    });
    const result = interpretResponse(response.data);
    if (result.success) {
      console.log(`[NETGSM] OTP gönderildi. Tel: ${phone}, JobID: ${result.jobId}`);
    } else {
      console.error(`[NETGSM] Gönderim reddedildi (${result.code}): ${result.error}`);
    }
    return { ...result, simulated: false };
  } catch (err) {
    console.error('[NETGSM] Ağ/HTTP hatası:', err.message);
    return { success: false, simulated: false, error: `Ağ hatası: ${err.message}` };
  }
}

// buildOtpXml/interpretResponse birim testleri için de dışa aktarılır (G6);
// dışarıdan çağıran üretim kodu yalnızca sendOtpSms kullanır.
module.exports = { sendOtpSms, buildOtpXml, interpretResponse, OTP_ENDPOINT };
