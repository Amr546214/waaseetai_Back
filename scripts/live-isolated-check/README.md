Live isolated UI-to-API check (NOT part of `npm test`; nothing here touches dev / production).
1. Isolated Docker DB built from the real migration chain (qa_base_a template + `prisma migrate deploy`), the backend started locally on it (`PORT=5077`, test secrets, SMTP to a closed port, no OTP flow used).
2. `seed.ts <out.json>` creates synthetic users / contracts and test JWTs; `drive.mjs <dir>` performs administrative release + a consensual cancellation through the REAL HTTP endpoints.
3. The FE (`ng serve`) is opened in headless Chromium by `ui.mjs` (playwright-core): the app's API origin is forwarded to the isolated local API and every other external host is aborted.
Scratch paths inside the scripts point at the author's session directory; adjust before reuse.
