# Baileys REST WhatsApp Service

Node.js + Express service that wraps `@whiskeysockets/baileys` and exposes a REST API for WhatsApp messaging.

## Features

- Persistent auth state in `/data/auth`
- Event log in `/data/events.log`
- Incoming/status webhook delivery with retry/backoff
- QR login support
- REST endpoints for health, auth reset, text/media/poll sending
- API key protection on every endpoint

## Authentication

Every API request must include a valid API key.

Use either:

- Header: `x-api-key: <API_KEY>`
- Header: `Authorization: Bearer <API_KEY>`

If key is missing or invalid, the API returns:

- `401 Unauthorized`
- Body: `{ "ok": false, "message": "Unauthorized" }`

## Environment Variables

See `.env.example`. Main values:

- `PORT` HTTP port inside the app
- `HOST` bind host (use `0.0.0.0` in containers)
- `API_KEY` shared API key required for all requests
- `DATA_DIR` folder for auth + event data
- `WEBHOOK_URL` destination URL for event callbacks

## Endpoint Reference

Base URL example: `http://localhost:3000`

All requests require API key headers.

### `GET /health`

Returns service status and WhatsApp connection state.

Query params:

- none

Example response:

```json
{
  "ok": true,
  "service": "baileys-rest-service",
  "now": "2026-02-14T18:20:00.000Z",
  "whatsapp": {
    "connected": false,
    "lastDisconnectReason": null,
    "reconnectAttempts": 0,
    "hasQr": true,
    "me": null
  }
}
```

### `GET /auth/qr`

Returns current QR data used for login.

Query params:

- none

Response notes:

- `200` with QR payload when available
- `404` when no active QR exists (already authenticated or not yet generated)

Example response:

```json
{
  "ok": true,
  "connected": false,
  "qr": "<raw-qr-string>",
  "qrDataUrl": "data:image/png;base64,...",
  "updatedAt": "2026-02-14T18:20:00.000Z"
}
```

### `GET /events`

Returns logged events within a date range.

Query params:

- `start_date` (required, ISO datetime)
- `end_date` (required, ISO datetime)

Example:

```bash
curl "http://localhost:3000/events?start_date=2026-02-14T00:00:00.000Z&end_date=2026-02-14T23:59:59.999Z"
```

Returns `400` for missing/invalid dates.

### `POST /auth/reset`

Clears auth state and forces a new login cycle.

Body:

- none

Example response:

```json
{
  "ok": true,
  "message": "Authentication state cleared. Re-authentication required."
}
```

### `POST /send/text`

Send a plain text WhatsApp message.

Body JSON:

- `target` (required): WhatsApp JID, personal or group
- `message` (required): text body

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "message": "Hello from API"
}
```

Group example target:

- `1203630XXXXXXXXX@g.us`

### `POST /send/media`

Send a media/document payload using base64 data.

Body JSON:

- `target` (required): WhatsApp JID, personal or group
- `base64` (required): base64 encoded file content
- `filename` (required): output file name
- `mimetype` (required): MIME type, e.g. `application/pdf`

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "base64": "<base64-data>",
  "filename": "report.pdf",
  "mimetype": "application/pdf"
}
```

### `POST /send/poll`

Send a poll message.

Body JSON:

- `target` (required): WhatsApp JID, personal or group
- `pollText` (required): poll question text
- `pollOptions` (required): array with at least 2 options

Example body:

```json
{
  "target": "1203630XXXXXXXXX@g.us",
  "pollText": "Where should we meet?",
  "pollOptions": ["Office", "Cafe", "Remote"]
}
```

## Quick Start (Docker Compose)

1. Copy env file:

```bash
cp .env.example .env
```

2. Set values in `.env` (especially `API_KEY` and `WEBHOOK_URL`).

3. Run:

```bash
docker compose up -d --build
```

4. Call API with key:

```bash
curl -H "x-api-key: YOUR_KEY" http://localhost:3000/health
```
