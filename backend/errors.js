/*
  =============================================================================
  errors.js — Merkezi Hata Yanıtı (D4)
  =============================================================================
  Kural: API'den dönen her hata JSON'dur ve ASLA yığın izi (stack) içermez.
  Express'in varsayılan hata sayfası HTML döner ve stack'i istemciye basar —
  bu hem arayüzü bozar hem de sunucunun iç yapısını sızdırır.

  Bu modül iki ara katman verir:
    - apiNotFound  : eşleşmeyen /api/* isteklerine 404 JSON
    - errorHandler : fırlatılan/iletilen hataları tek biçimli JSON'a çevirir

  Ayrıntı (mesaj, stack) sunucu konsoluna yazılır; istemci yalnızca ne olduğunu
  öğrenir, nerede olduğunu değil.
*/

/** Eşleşmeyen API yolları için JSON 404 (sayfa istekleri Express'e bırakılır). */
function apiNotFound(req, res, next) {
  if (!(req.originalUrl || req.url || '').startsWith('/api/')) return next();
  res.status(404).json({ message: 'Böyle bir uç nokta yok.', path: req.originalUrl });
}

/**
 * Merkezi hata ara katmanı — TÜM route'lardan SONRA kaydedilmelidir.
 * @param {Function} [logger] test edilebilirlik için; varsayılan console.error
 */
function makeErrorHandler(logger = console.error) {
  return function errorHandler(err, req, res, next) {
    // Yanıt başlamışsa müdahale edemeyiz — Express'in kendi kapatmasına bırak.
    if (res.headersSent) return next(err);

    const yol = req.originalUrl || req.url || '';

    // 1) Bozuk JSON gövdesi (express.json fırlatır)
    if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err))) {
      logger(`[HTTP-400] ${yol} — bozuk JSON gövdesi: ${err.message}`);
      return res.status(400).json({ message: 'Geçersiz JSON gövdesi.' });
    }

    // 2) Çok büyük gövde
    if (err && err.type === 'entity.too.large') {
      logger(`[HTTP-413] ${yol} — gövde çok büyük`);
      return res.status(413).json({ message: 'İstek gövdesi çok büyük.' });
    }

    // 3) Bilinen durum kodu taşıyan hatalar (ör. http-errors)
    const status = Number(err && (err.status || err.statusCode));
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      logger(`[HTTP-${status}] ${yol} — ${err.message}`);
      return res.status(status).json({ message: err.expose ? err.message : 'İstek reddedildi.' });
    }

    // 4) Beklenmeyen her şey: ayrıntı LOGA, istemciye sade mesaj (stack sızmaz)
    logger(`[HTTP-500] ${yol} — beklenmeyen hata:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ message: 'Sunucu hatası. Lütfen daha sonra tekrar deneyin.' });
  };
}

/**
 * Async route'ların reddedilen promise'lerini merkezi hata katmanına taşır.
 * Express 4, async handler'ların hatalarını kendiliğinden yakalamaz.
 */
function wrapAsync(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { apiNotFound, makeErrorHandler, wrapAsync };
