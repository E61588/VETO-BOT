# VETO bot (v2)

Submits parking-ticket appeals on municipal portals for VETO users.

- **Human steps stay human.** When a portal shows a reCAPTCHA checkbox, the job
  pauses and the user ticks it in a live view of the bot's browser inside VETO.
  When a portal sends an SMS code to the vehicle owner, the user types it in VETO
  and the bot continues. The bot never solves or bypasses a CAPTCHA.
- **No guessing.** Each portal family has its own adapter in `adapters/`. A step
  that is not mapped yet stops the job (`NOT_MAPPED`) and saves the page
  structure (field names and labels, never values) for mapping.
- **Live submission is off by default.** Every job stops at `READY_TO_SUBMIT`,
  after the last screen is filled and before the final button, unless the server
  has `ALLOW_LIVE_SUBMIT=true` and the job has `submit_live: true`.

## Status of portal adapters

| Portal | Authorities | Status |
|---|---|---|
| Metropark | Raanana, Petah Tikva, Netanya, Bat Yam, Bnei Brak and others (by AuthorityID) | Step 1 (search with reCAPTCHA in live view) done; step 2 to be mapped |
| Tel Aviv, Jerusalem | | Not started (OTP identification + invisible reCAPTCHA) |
| Mileon | Ramat Gan, Herzliya, Givatayim and others | Not started |
| City4U | Haifa, Rishon LeZion, Beer Sheva | Blocked by the portal's firewall from automated access |

## API (all routes except `/health` need header `x-api-key`)

- `POST /api/jobs` (or `/api/submit-appeal`): `{ job_id, portal_url, ticket_number, vehicle_number, driver_details, appeal_letter, attachment_urls, submit_live }`
- `GET /api/jobs/:id` — status
- `POST /api/verify-otp` — `{ job_id, otp_code }`
- `POST /api/jobs/:id/cancel`
- `GET /api/recon`, `GET /api/recon/:file` — mapped page structure
- WebSocket `/live?token=<viewer token>` — live view; token is
  `<jobId>.<exp>.<HMAC-SHA256("viewer:"+BOT_API_KEY, jobId+"."+exp) base64url>`

Status updates go to `WEBHOOK_URL` (Base44 `automationWebhook`) with `x-api-key`.

## Run

`deploy/user-data.sh` sets up an Ubuntu 24.04 server (AWS Tel Aviv) end to end.
Locally: `npm install && npx playwright install chromium && npm test`.
