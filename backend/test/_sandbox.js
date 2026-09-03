/*
  =============================================================================
  Test kum havuzu (test/_sandbox.js)
  =============================================================================
  Testler ASLA gerçek `backend/db.json`'a veya `backend/logs/` içeriğine
  dokunmamalıdır: orada gerçek misafir kayıtları ve 5651 delil logları var.

  Bu yardımcı iki yönlendirme sunar:
    - sandboxJsonFile(yol, baslangic) → tek bir dosyayı bellek içi tampona alır.
    - sandboxDir(yol)                 → bir dizinin ALTINDAKİ tüm işlemleri
                                        geçici bir dizine yönlendirir.

  Yönlendirme `fs` seviyesinde yapılır; test edilen modül (db.js, kamusm-signer.js)
  kendi yollarını normal şekilde kullanır, veri gerçek dosyalara gitmez.

  KULLANIM: yönlendirme, ilgili modül `require` edilmeden ÖNCE kurulmalıdır —
  db.js yüklenirken db.json'u hemen okuyor.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');

const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync,
  unlinkSync: fs.unlinkSync,
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
};

// Bellek içi dosyalar: mutlak yol -> içerik (string)
const files = new Map();
// Dizin yönlendirmeleri: { from: mutlak gerçek dizin, to: mutlak geçici dizin }
const dirs = [];

let patched = false;

// Windows'ta yol karşılaştırması büyük/küçük harf duyarsızdır.
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Bellek içi dosya anahtarı (yoksa null).
function memKey(p) {
  if (typeof p !== 'string') return null;      // fd / Buffer / URL → dokunma
  const abs = path.resolve(p);
  return files.has(abs) ? abs : null;
}

// Dizin yönlendirmesi uygula (yoksa yolun kendisini döndür).
function remap(p) {
  if (typeof p !== 'string') return p;
  const abs = path.resolve(p);
  for (const { from, to } of dirs) {
    if (norm(abs) === norm(from)) return to;
    if (norm(abs).startsWith(norm(from) + path.sep)) return path.join(to, abs.slice(from.length));
  }
  return p;
}

function patch() {
  if (patched) return;
  patched = true;

  fs.readFileSync = function (p, ...rest) {
    const key = memKey(p);
    if (key !== null) return files.get(key);
    return real.readFileSync.call(fs, remap(p), ...rest);
  };

  fs.writeFileSync = function (p, data, ...rest) {
    const key = memKey(p);
    if (key !== null) { files.set(key, String(data)); return; }
    return real.writeFileSync.call(fs, remap(p), data, ...rest);
  };

  fs.existsSync = function (p) {
    const key = memKey(p);
    if (key !== null) return true;
    return real.existsSync.call(fs, remap(p));
  };

  // Atomik yazma (yaz + rename) kum havuzunda da çalışmalı: kaynak bellekteyse
  // hedef de belleğe alınır — gerçek db.json'a ASLA dokunulmaz.
  fs.renameSync = function (src, dst, ...rest) {
    const srcKey = memKey(src);
    if (srcKey !== null) {
      const icerik = files.get(srcKey);
      files.set(path.resolve(dst), icerik);
      files.set(srcKey, '');        // kaynak boşalır ama kayıtlı kalır
      return;
    }
    return real.renameSync.call(fs, remap(src), remap(dst), ...rest);
  };

  fs.readdirSync = function (p, ...rest) { return real.readdirSync.call(fs, remap(p), ...rest); };
  fs.unlinkSync = function (p, ...rest) { return real.unlinkSync.call(fs, remap(p), ...rest); };
  fs.mkdirSync = function (p, ...rest) { return real.mkdirSync.call(fs, remap(p), ...rest); };
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
  files.set(abs + '.tmp', '');   // atomik yazmanın geçici dosyası da bellekte kalsın
  patch();
  return {
    read: () => JSON.parse(files.get(abs)),
    write: (obj) => files.set(abs, JSON.stringify(obj)),
    // Ham erişim — atomik yazma / bozuk dosya senaryolarını test edebilmek için.
    rawGet: (p = abs) => files.get(path.resolve(p)),
    rawSet: (icerik, p = abs) => files.set(path.resolve(p), icerik),
    rawKeys: () => [...files.keys()],
  };
}

/**
 * Bir dizini (ve altındaki her şeyi) geçici bir dizine yönlendirir.
 * @param {string} absDir Yönlendirilecek gerçek dizin (ör. logs/5651_captive)
 * @returns {{ dir: string, cleanup: () => void }} geçici dizin ve temizleyici
 */
function sandboxDir(absDir) {
  const from = path.resolve(absDir);
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-test-'));
  dirs.push({ from, to });
  patch();
  return {
    dir: to,
    cleanup: () => { try { real.rmSync(to, { recursive: true, force: true }); } catch (_) {} },
  };
}

module.exports = { sandboxJsonFile, sandboxDir };
