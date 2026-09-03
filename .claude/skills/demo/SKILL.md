---
name: demo
description: Runs and verifies the end-to-end 5651 captive portal demo — starts the server, generates virtual guests, checks RADIUS sessions and 5651 logs. Use when the user says "run the demo", "test the system", "start the simulation", "prepare for the customer demo", "demoyu çalıştır".
---

# Run and Verify the End-to-End Demo

Goal: prove that the ENTIRE hardware-free simulation (portal → OTP → RADIUS →
5651 log) works. This is the final check before a customer presentation.

## Preconditions

1. Does `backend/.env` exist? If not, copy it from `.env.example` (NEVER print
   its contents).
2. Check `simMode` via `GET http://localhost:3000/api/config`:
   - If the server isn't up → start with step 1 below.
   - If `simMode: false` → STOP and tell the user. Don't change `.env` on your
     own; touching real-SMS mode is the user's decision.

## Steps

1. Start the `wifi-portal` server via `preview_start` (don't restart it if
   it's already running).
2. Confirm in the server logs that all three services come up clean:
   HTTP (3000), RADIUS (UDP 1812/1813), Syslog (UDP 514). On "EADDRINUSE",
   find and kill the stale `node` process; don't change the port.
3. Run `cd backend; npm run simulate 5 2` (PowerShell 5.1 has no `&&` — use `;`).
4. Verify:
   - The simulation output shows all 5 of 5 guests with open sessions; no error lines.
   - `GET /api/dashboard/sessions` → at least 1 active session.
   - `GET /api/dashboard/logs` → 5651 lines with resolved phone numbers present.
5. UI proof: take a screenshot of `/dashboard` (with populated tables).

## Output format

Give a short report, in exactly this structure:

```
Demo result: PASS | PARTIAL | FAIL
- Guests: 5/5 opened sessions
- Active sessions: <n>, 5651 log lines: <n>
- Phone resolution: <one masked sample, e.g. 5XX***1234>
- Issues: <one sentence if any, otherwise "none">
```

Then the dashboard screenshot. On FAIL: show the raw error output of the
failing step, state the root cause, suggest the fix — but never wipe
`db.json`/`logs` unless the user asks.

## Never do

- Change `SIM_MODE` on your own.
- Write full phone numbers in the report — mask the middle digits.
- Call `/api/dashboard/clear-logs` or `/reset` without asking (the demo data
  may be deliberately populated for a customer presentation).
- Shut the server down when the demo finishes — the user will most likely
  look at the dashboard.
