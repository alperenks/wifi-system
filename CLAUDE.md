# CLAUDE.md — wifi-system

A 5651-law-compliant guest Wi-Fi captive portal system with NetGSM SMS-OTP.
It has two faces:

1. **Simulation (the heart of this repo):** Node/Express under `backend/` —
   a hardware-free, end-to-end demo on a single machine. Serves as
   proof-of-feasibility for the customer and as a learning environment.
2. **Field deployment (August 2026, a restaurant in Istanbul):**
   `pfsense-files/` goes onto pfSense, `esp32-bridge/` onto an ESP32. These
   folders are production artifacts — they are NOT part of the simulation;
   consider the field impact before changing them.

Language: code comments and docs in English is fine; **guest-facing UI text
stays Turkish** (the customers are Turkish restaurant guests). Follow the
comment density and instructive style of the existing files.

## Commands

```bash
cd backend
npm install
copy .env.example .env      # first-time setup; SIM_MODE=true is the default
npm start                   # portal(3000) + RADIUS(1812/1813 UDP) + Syslog(514 UDP) + signing cron
npm run simulate [guests] [rounds]   # e.g. npm run simulate 6 3 — server must be RUNNING
```

- A dev server named `wifi-portal` is defined in `.claude/launch.json` — when
  browser verification is needed, use `preview_start` with it instead of
  running `node server.js` by hand.
- There is NO test framework. Verification = run the server and check
  end-to-end via simulation (see "Change verification" below).

## Architecture map (backend/)

| File | Responsibility |
|---|---|
| `config.js` | All settings from `.env`; the `SIM_MODE` switch is read here |
| `server.js` | Portal + dashboard + `/api/send-otp`, `/api/verify-otp`, `/api/sim/*`, `/api/dashboard/*` |
| `netgsm.js` | Real NetGSM OTP POST; returns a fake OTP in SIM_MODE |
| `radius-server.js` | UDP 1812/1813 — FreeRADIUS impersonation (Access-Request/Accounting) |
| `radius-client.js` | Software NAS — emits REAL RADIUS packets once the OTP is verified |
| `syslog-server.js` | UDP 514 — parses pfSense `filterlog` + `unbound` formats |
| `kamusm-signer.js` | Daily log → gz + SHA256 + RFC 3161 timestamp (mocked in SIM) |
| `db.js` / `db.json` | JSON database; DHCP leases (MAC↔IP), sessions, OTPs |
| `simulate.js` | Virtual guest crowd — talks to the running server over HTTP |
| `views/` | `captive.html` (guest portal), `dashboard.html` (control panel) |
| `logs/5651_captive/` | Daily 5651 evidence logs + signed archives |

**What SIM_MODE means (the most critical concept):** with `SIM_MODE=true` no
real SMS is sent and the OTP appears in the UI; but once the OTP is verified,
the server impersonates a NAS and opens a **real RADIUS session** — the
dashboard fills up and the 5651 log resolves the phone number. The `/api/sim/*`
endpoints exist only in this mode. `SIM_MODE=false` = field mode: real NetGSM
SMS + real pfSense/ESP32.

## Do / Don't

- **Never read `.env` and print its contents, never suggest committing it.**
  The NetGSM password and RADIUS secret live there. Use `.env.example` for examples.
- **Never set `SIM_MODE=false` during development.** Real (paid) SMS goes out
  and the simulation endpoints shut down. Only the user decides the field switch.
- **Never change the 5651 log line format or the signing chain
  (gz+SHA256+RFC3161)** — this is a legal-evidence format. If a format change
  seems necessary, ask the user first.
- **Never delete `db.json` or `logs/` contents by hand.** Cleanup endpoints
  exist: `/api/dashboard/reset` and `/api/dashboard/clear-logs`; use those.
- On a port conflict (3000, UDP 1812/1813/514): find and kill the stale
  `node` process; don't change the port.
- The project lives under OneDrive and is not a git repo — file-lock errors
  may come from OneDrive sync; retry, don't suggest moving the project.
- `pfsense-files/*.php` and `esp32-*/*.ino` are a different world from the
  backend (PHP/MySQL, Arduino C++). The `restoran_secret`, table names
  (`radcheck`/`radreply`), and SSID (`Restoran_Misafir_Wifi`) there must match
  the backend side — if you change one, update them all.

## Change verification (after every backend change)

1. Start the `wifi-portal` server (preview_start) and confirm all three
   services (HTTP/RADIUS/Syslog) come up clean in the logs.
2. Run `npm run simulate 3 2` — all 3 guests must end with an open session.
3. `GET /api/dashboard/sessions` must be non-empty; `GET /api/dashboard/logs`
   must show lines with resolved phone numbers.
4. If the UI changed: prove it with screenshots of
   `http://localhost:3000/captive` and `/dashboard`.

## Docs

- `docs/SIMULASYON-REHBERI.md` — the three levels: pure software → ESP32 → pfSense VM
- `docs/WIRESHARK-REHBERI.md` — observing RADIUS/Syslog packets
- `README.md` — pfSense VM setup and field steps (user-facing, in Turkish)
