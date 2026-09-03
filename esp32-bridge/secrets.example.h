/*
  secrets.example.h — ŞABLON
  ---------------------------------------------------------------------------
  Bu dosyayı "secrets.h" olarak kopyalayın ve SHARED_SECRET'i doldurun.
  Bu değer, backend .env dosyasındaki ESP32_SHARED_SECRET ile BİREBİR AYNI olmalıdır;
  aksi halde HMAC imzaları tutmaz ve yetkilendirme reddedilir.

  Rastgele güçlü bir değer üretmek için (backend tarafında):
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

  secrets.h dosyası .gitignore'dadır ve public repoya ASLA girmez.
*/
#ifndef SECRETS_H
#define SECRETS_H

#define SHARED_SECRET "BURAYA_BACKEND_ILE_AYNI_GIZLI_ANAHTARI_YAZIN"

#endif
