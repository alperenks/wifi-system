/*
  =============================================================================
  validate.js — İstek Gövdesi Şema Doğrulaması (D3)
  =============================================================================
  Kural: istemciden gelen hiçbir alan doğrulanmadan iş mantığına girmez.
  Her uç noktanın beklediği alanlar burada bir şema ile bildirilir; şemada
  olmayan alan gönderilirse istek 400 ile reddedilir (sessizce yok sayılmaz —
  yok saymak, yanlış alan adıyla gönderilen bir isteğin "başarılı" görünmesine
  ve hata ayıklamanın zorlaşmasına yol açar).

  Doğrulayıcılar gövdeyi DEĞİŞTİRMEZ; yalnızca kabul/ret kararı verir.
  Normalizasyon (MAC küçük harfe indirme vb.) eskiden olduğu gibi db.js'te yapılır.

  Kullanım:
    app.post('/api/verify-otp',
      validateBody({ mac: { type: 'mac', required: true },
                     otp: { type: 'otp', required: true } }),
      handler);
*/

/**
 * Telefonu kanonik biçime getirir: başında 0 olmadan 10 hane (5XXXXXXXXX).
 * Geçersizse null döner. Ayraç olarak yalnızca boşluk, tire, nokta ve parantez
 * kabul edilir — başka hiçbir karakter numaranın içinde olamaz.
 */
function normalizePhone(v) {
  // Baştaki 0 BİLEREK kabul edilmiyor: portal "başında 0 olmadan" diyor ve
  // güvenlik düzeltmesi kabul edilen girdi yüzeyini genişletmemeli.
  const haneler = String(v == null ? '' : v).trim().replace(/[\s().-]/g, '');
  return /^5[0-9]{9}$/.test(haneler) ? haneler : null;
}

// --- Tip doğrulayıcıları -----------------------------------------------------

const TYPES = {
  // 12 hex hane; ':', '-', '.' veya ayraçsız kabul edilir (aa:bb:cc:dd:ee:ff)
  mac(v) {
    if (typeof v !== 'string') return 'metin olmalı';
    const clean = v.toLowerCase().replace(/[:\-.\s]/g, '');
    return /^[0-9a-f]{12}$/.test(clean) ? null : 'geçerli bir MAC adresi olmalı';
  },

  // Başında 0 olmadan 5XXXXXXXXX.
  // DİKKAT: yalnızca yaygın AYRAÇLAR (boşluk, tire, parantez, nokta) temizlenir;
  // eskiden "rakam olmayan her şey" silinip test ediliyordu, bu yüzden
  // "5551112233<img ...>" veya satır sonu içeren bir değer doğrulamadan geçip
  // ham hâliyle saklanıyordu (5651 log satırına enjeksiyon + panelde XSS).
  phone(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return 'metin olmalı';
    return normalizePhone(v) ? null : '5XXXXXXXXX biçiminde olmalı';
  },

  // 6 haneli sayısal doğrulama kodu
  otp(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return 'metin olmalı';
    return /^[0-9]{6}$/.test(String(v)) ? null : '6 haneli sayı olmalı';
  },

  // IPv4 noktalı gösterim
  ip(v) {
    if (typeof v !== 'string') return 'metin olmalı';
    const parts = v.split('.');
    if (parts.length !== 4) return 'geçerli bir IPv4 adresi olmalı';
    const ok = parts.every(p => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255);
    return ok ? null : 'geçerli bir IPv4 adresi olmalı';
  },

  int(v, rule) {
    // true/false Number() ile 1/0'a dönüşüyordu; sonra handler'daki parseInt(true)
    // NaN veriyor ve uç nokta "başarılı" ama hiçbir iş yapmamış oluyordu.
    if (typeof v !== 'number' && typeof v !== 'string') return 'tam sayı olmalı';
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n)) return 'tam sayı olmalı';
    if (rule.min !== undefined && n < rule.min) return `en az ${rule.min} olmalı`;
    if (rule.max !== undefined && n > rule.max) return `en fazla ${rule.max} olmalı`;
    return null;
  },

  string(v, rule) {
    if (typeof v !== 'string') return 'metin olmalı';
    const max = rule.maxLength || 256;
    if (v.length > max) return `en fazla ${max} karakter olabilir`;
    if (rule.values && !rule.values.includes(v)) return `şunlardan biri olmalı: ${rule.values.join(', ')}`;
    return null;
  },
};

/**
 * Gövdeyi şemaya göre doğrular.
 * @param {object} body
 * @param {object} schema  { alan: { type, required, min, max, maxLength, values } }
 * @returns {{ field:string, reason:string }|null}  hata yoksa null
 */
function checkBody(body, schema) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { field: '(gövde)', reason: 'JSON nesnesi olmalı' };
  }

  // Şemada olmayan alan → reddet (yazım hatası sessizce yutulmasın)
  for (const key of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return { field: key, reason: 'beklenmeyen alan' };
    }
  }

  for (const [key, rule] of Object.entries(schema)) {
    const value = body[key];
    const eksik = value === undefined || value === null || value === '';

    if (eksik) {
      if (rule.required) return { field: key, reason: 'zorunlu alan' };
      continue;
    }

    const validator = TYPES[rule.type];
    if (!validator) return { field: key, reason: `bilinmeyen tip: ${rule.type}` };

    const hata = validator(value, rule);
    if (hata) return { field: key, reason: hata };
  }

  return null;
}

/**
 * Express ara katmanı üretir.
 * @param {object} schema
 */
function validateBody(schema) {
  return function (req, res, next) {
    const hata = checkBody(req.body, schema);
    if (hata) {
      return res.status(400).json({
        message: `Geçersiz istek: "${hata.field}" alanı ${hata.reason}.`,
        field: hata.field,
      });
    }
    next();
  };
}

module.exports = { validateBody, checkBody, TYPES, normalizePhone };
