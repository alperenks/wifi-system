/*
  =============================================================================
  Test kum havuzu (test/_sandbox.js)
  =============================================================================
  Testler ASLA gerçek `backend/db.json`'a veya `backend/logs/` içeriğine
  dokunmamalıdır: orada gerçek misafir kayıtları ve 5651 delil logları var.

  Bu yardımcı, belirtilen dosya yolunu `fs` seviyesinde bellek içi bir tampona
  yönlendirir. Modül (ör. db.js) kendi `writeFileSync`/`readFileSync`
  çağrılarını normal şekilde yapar; veri diske değil, RAM'e gider.

  KULLANIM: sandboxJsonFile(...) çağrısı, ilgili modül `require` edilmeden
  ÖNCE yapılmalıdır — db.js yüklenirken dosyayı hemen okuyor.
*/

const fs = require('fs');
const path = require('path');

const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
};

// Yönlendirilen yollar: mutlak yol -> bellekteki içerik (string)
const files = new Map();

let patched = false;

function keyFor(p) {
  if (typeof p !== 'string') return null;      // fd / Buffer / URL → dokunma
  const abs = path.resolve(p);
  return files.has(abs) ? abs : null;
}

function patch() {
  if (patched) return;
  patched = true;

  fs.readFileSync = function (p, ...rest) {
    const key = keyFor(p);
    if (key !== null) return files.get(key);
    return real.readFileSync.call(fs, p, ...rest);
  };

  fs.writeFileSync = function (p, data, ...rest) {
    const key = keyFor(p);
    if (key !== null) { files.set(key, String(data)); return; }
    return real.writeFileSync.call(fs, p, data, ...rest);
  };

  fs.existsSync = function (p) {
    const key = keyFor(p);
    if (key !== null) return true;
    return real.existsSync.call(fs, p);
  };
}

/**
 * Bir JSON dosyasını bellek içi tampona yönlendirir.
 * @param {string} absPath  Yönlendirilecek mutlak dosya yolu
 * @param {object} initial  Dosyanın başlangıç içeriği
 * @returns {{ read: () => object, write: (obj:object) => void }}
 */
function sandboxJsonFile(absPath, initial = {}) {
  const abs = path.resolve(absPath);
  files.set(abs, JSON.stringify(initial));
  patch();
  return {
    read: () => JSON.parse(files.get(abs)),
    write: (obj) => files.set(abs, JSON.stringify(obj)),
  };
}

module.exports = { sandboxJsonFile };
