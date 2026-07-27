# VETO Bot Server

Playwright + Express automation server for submitting traffic ticket appeals
and handling SMS/OTP verification on municipal websites, with webhook
callbacks to Base44.

## Project layout

```
server.js            Express app + route handlers
browserAutomation.js  Playwright logic: form fill, OTP submit, screenshot
sessionStore.js       In-memory Map of paused browser sessions, keyed by job_id
webhook.js            Helper for POSTing status updates back to Base44
authMiddleware.js      x-api-key header check
config.js             Loads/validates environment variables
Dockerfile             Based on mcr.microsoft.com/playwright (Chromium preinstalled)
```

## Setup

```bash
npm install
cp .env.example .env   # then edit BOT_API_KEY
npm start
```

## Environment variables

| Variable                 | Description                                             | Default |
|---------------------------|-----------------------------------------------------------|---------|
| `BOT_API_KEY`             | Required value for the `x-api-key` header                | (none)  |
| `PORT`                    | HTTP port                                                | 3000    |
| `OTP_SESSION_TIMEOUT_MS`  | How long a paused session waits for OTP before expiring   | 120000  |
| `WEBHOOK_TIMEOUT_MS`      | Timeout for outbound webhook POSTs                        | 10000   |

## API

All routes below (except `/health`) require header: `x-api-key: <BOT_API_KEY>`

### `POST /api/submit-appeal`

```json
{
  "job_id": "abc123",
  "municipality_url": "https://example-city.gov/appeal",
  "appeal_letter": "I am appealing this ticket because...",
  "driver_details": {
    "id_number": "123456789",
    "phone": "0501234567",
    "vehicle_number": "12-345-67",
    "ticket_number": "TCK-9988"
  },
  "webhook_url": "https://base44.example.com/webhooks/veto"
}
```

Responds `202 { job_id, status: "PROCESSING" }` immediately, then in the
background: launches Chromium, fills the form, clicks "Send OTP", stashes
the live browser/page in memory, and POSTs a webhook with
`{ status: "AWAITING_OTP" }`. If nothing calls `/api/verify-otp` within
`OTP_SESSION_TIMEOUT_MS`, the session is closed and a
`{ status: "EXPIRED" }` webhook is sent instead.

### `POST /api/verify-otp`

```json
{ "job_id": "abc123", "otp_code": "482913" }
```

Fills in the OTP, submits, waits for the confirmation screen, extracts a
confirmation/reference number, screenshots the result to
`./screenshots/<job_id>.png`, closes the browser, and POSTs a webhook with
`{ status: "COMPLETED", confirmation_number }` (or `{ status: "FAILED" }`
on error).

## Adapting to a real municipality site

`browserAutomation.js` uses a list of best-effort CSS/text selectors per
field (`SELECTORS` at the top of the file) since every municipality's HTML
differs. For a new municipality, either:

1. Add more candidate selectors to the existing arrays, or
2. Introduce a per-domain selector-override map keyed by
   `new URL(municipality_url).hostname` and merge it over the defaults.

## Docker

```bash
docker build -t veto-bot-server .
docker run --rm -p 3000:3000 --env-file .env veto-bot-server
```

The image is based on `mcr.microsoft.com/playwright`, which already bundles
Chromium and all required OS dependencies — no `playwright install` step
needed at runtime.

## Notes / production hardening ideas

- Sessions currently live in an in-memory `Map`, so they don't survive a
  process restart and won't work across multiple server instances. For
  horizontal scaling, move to a sticky-session load balancer or externalize
  session state (e.g. Redis + a headless-browser pool service).
- Consider persisting screenshots to object storage (S3/GCS) rather than
  local disk if running in an ephemeral container.
- Add structured logging/monitoring around job status transitions.
