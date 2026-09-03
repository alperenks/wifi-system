---
name: field-check
description: Pre-flight audit before the August 2026 field deployment (Istanbul restaurant) — audits .env field settings, backend↔pfSense↔ESP32 consistency, and the 5651 signing chain. Use when the user says "are we ready for the field", "deployment check", "going live", "check the pfSense files", "saha kontrolü".
---

# Field Deployment Pre-Flight Check

Goal: catch everything missing or inconsistent on the software side before
heading to the restaurant for installation. This is an AUDIT — never modify
any file unprompted; report findings and apply fixes only if the user approves.

## Checklist

Check each item in order and mark it ✅/❌/⚠️:

**1. `.env` field readiness** (read the file but NEVER show the VALUES in the
report — only say "set/empty"):
   - Is `SIM_MODE=false`? (Required for the field; if still true, ⚠️ "demo mode")
   - Are `NETGSM_USERNAME`, `NETGSM_PASSWORD`, `NETGSM_HEADER` set?
   - Is `ESP32_AP_URL` set? (If empty, authorization never reaches the ESP32)
   - Is `RADIUS_SECRET` still a demo default (e.g. `restoran_secret`,
     `sim-radius-secret`) or empty? If so, ⚠️ suggest generating a real one.

**2. Backend ↔ pfSense consistency:**
   - Do the NetGSM fields, rate limit, and simulation flag in
     `pfsense-files/captiveportal-config.php` contradict the backend `.env` logic?
   - Is the RADIUS shared secret identical in both places that hold a real value:
     backend `.env` (`RADIUS_SECRET`) and the PHP config? Setup docs must only
     carry the `<RADIUS_SECRET_DEGERINIZ>` placeholder — flag any real secret
     that appears in a .md file.
   - Do the table names in the `radius.sql` schema (`radcheck`, `radreply`)
     match what the PHP side uses?

**3. ESP32:**
   - Is the SSID in `esp32-bridge/esp32-bridge.ino` `Restoran_Misafir_Wifi`,
     matching what the portal/PHP side expects?
   - Does the `/authorize` endpoint the backend calls actually exist in the .ino?

**4. 5651 signing chain:**
   - Is `KAMUSM_TSA_URL` the real address (`http://zd.kamusm.gov.tr`)?
   - Is `SIGN_CRON` set to run daily (`59 23 * * *`)?
   - Has `logs/5651_captive/` produced signed archives (at least one gz+signature pair)?

**5. General:** is `npm install` clean, and does `node server.js` start without
   crashing under SIM_MODE=false? (Start it and check ONLY the startup logs —
   do NOT send an OTP; a real SMS would go out.)

## Output format

```
FIELD PRE-FLIGHT REPORT — <date>
✅ Passed: <n>  ⚠️ Warnings: <n>  ❌ Blockers: <n>

❌ BLOCKERS (cannot deploy):
- <item + one-sentence reason + suggested fix>

⚠️ WARNINGS (deployable but risky):
- <item + reason>

✅ PASSED: <single-line list>

Verdict: READY / FIXES REQUIRED
```

Example blocker line: "❌ NETGSM_HEADER is empty — the SMS sender header is
unapproved, so NetGSM will reject OTP delivery. Enter the approved header from
the NetGSM panel into .env."

## Never do

- Write password/appkey VALUES from `.env` or the PHP config into the report,
  console, or command line. Only state set/empty/default status.
- Trigger a real SMS: never call `/api/send-otp` or run `simulate` while
  SIM_MODE=false.
- Modify any config file without asking — this skill is audit-only.
- Attempt to connect to the pfSense VM or the ESP32; this check covers repo
  files only.
