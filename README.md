# Baileys REST WhatsApp Service

Node.js + Express service that wraps `@whiskeysockets/baileys` and exposes a REST API for WhatsApp messaging. Auth state, event logs, and webhook queues are all persisted in MySQL.

## Features

- MySQL-backed auth state (credentials survive restarts)
- Persistent event log in `wa_events` table
- Persistent webhook delivery queue with retry/backoff (survives restarts)
- Automatic re-auth on device removal — no manual reset required
- Exponential backoff reconnection with configurable max attempts
- QR login via API or terminal
- REST endpoints for health, auth, messaging, contacts, locations, groups, and message deletion
- API key protection on every endpoint

## Requirements

- Node.js ≥ 18
- MySQL 5.7+ or MariaDB 10.3+

See [INSTALL.md](./INSTALL.md) for database setup and table creation.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values.

| Variable          | Description                                           |
|-------------------|-------------------------------------------------------|
| `PORT`            | HTTP port (default `3000`)                            |
| `HOST`            | Bind host (use `0.0.0.0` in containers)               |
| `API_KEY`         | Shared secret required for all API requests           |
| `WHATSAPP_NUMBER` | Phone number this instance manages (digits only, no `+`) |
| `DB_HOST`         | MySQL host                                            |
| `DB_PORT`         | MySQL port (default `3306`)                           |
| `DB_USER`         | MySQL user                                            |
| `DB_PASSWORD`     | MySQL password                                        |
| `DB_NAME`         | MySQL database name                                   |

Webhook URL and all per-number tuning values (timeouts, retry counts, reconnect delays) are stored in the `wa_numbers` table and loaded at startup. Update them directly in the DB and restart the service to apply.

## Authentication

Every API request must include a valid API key via one of:

- `x-api-key: <API_KEY>`
- `Authorization: Bearer <API_KEY>`

Missing or invalid key returns `401 Unauthorized`.

## Endpoint Reference

Base URL example: `http://localhost:3000`

All requests require API key headers.

---

### `GET /health`

Returns service status, WhatsApp connection state, DB reachability, and memory usage.

Returns `200` when the DB is reachable and the service is not in a dead state. Returns `503` when the DB is down or the service has exhausted reconnect attempts.

Example response:

```json
{
  "ok": true,
  "service": "baileys-rest-service",
  "now": "2026-02-14T18:20:00.000Z",
  "whatsapp": {
    "connected": true,
    "dead": false,
    "lastDisconnectReason": null,
    "reconnectAttempts": 0,
    "hasQr": false,
    "me": { "id": "15551234567@s.whatsapp.net", "name": "My Name" },
    "webhookQueueSize": 0,
    "eventBufferSize": 42
  },
  "db": { "ok": true },
  "memory": {
    "heapUsedMb": 85,
    "heapTotalMb": 120,
    "rssMb": 145
  }
}
```

`dead: true` means the service has exceeded the maximum reconnect attempts and requires a process restart to recover.

---

### `GET /auth/qr`

Returns the current QR code for WhatsApp login.

- `200` with QR payload when a QR is waiting to be scanned
- `404` when no QR is active (already authenticated, or not yet generated)

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

---

### `GET /events`

Returns events from the `wa_events` table within a date range.

Query params:

| Param        | Required | Format                        |
|--------------|----------|-------------------------------|
| `start_date` | Yes      | ISO-8601, e.g. `2026-02-14T00:00:00.000Z` |
| `end_date`   | Yes      | ISO-8601, e.g. `2026-02-14T23:59:59.999Z` |

Returns `400` for missing or invalid dates, or if `start_date > end_date`.

Example:

```bash
curl -H "x-api-key: YOUR_KEY" \
  "http://localhost:3000/events?start_date=2026-02-14T00:00:00.000Z&end_date=2026-02-14T23:59:59.999Z"
```

---

### `POST /auth/reset`

Clears all auth state from the DB and forces a new login cycle. A new QR code will be generated.

Body: none

Example response:

```json
{
  "ok": true,
  "message": "Authentication state cleared. Re-authentication required."
}
```

Note: if a linked device is removed from the host phone, the service automatically clears its auth state and restarts the QR flow — no manual reset required.

---

### `POST /send/text`

Send a plain text message.

Body:

| Field     | Required | Type   | Description                     |
|-----------|----------|--------|---------------------------------|
| `target`  | Yes      | string | Recipient JID                   |
| `message` | Yes      | string | Message text                    |
| `replyTo` | No       | object | Quote a previous message (see [replyTo](#replyto-object)) |

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "message": "Hello from API"
}
```

With reply:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "message": "Got it!",
  "replyTo": {
    "id": "ABCDEF1234567890",
    "fromMe": false
  }
}
```

Group JID format: `1203630XXXXXXXXX@g.us`

---

### `POST /send/media`

Send a file/document as a base64 payload.

Body:

| Field      | Required | Type   | Description                             |
|------------|----------|--------|-----------------------------------------|
| `target`   | Yes      | string | Recipient JID                           |
| `base64`   | Yes      | string | Base64-encoded file content             |
| `filename` | Yes      | string | File name shown to recipient            |
| `mimetype` | Yes      | string | MIME type, e.g. `application/pdf`       |
| `message`  | No       | string | Optional caption displayed with the file |
| `replyTo`  | No       | object | Quote a previous message (see [replyTo](#replyto-object)) |

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "base64": "<base64-data>",
  "filename": "report.pdf",
  "mimetype": "application/pdf",
  "message": "Here is the report you requested."
}
```

---

### `POST /send/contact`

Send a contact card.

Body:

| Field          | Required | Type   | Description                             |
|----------------|----------|--------|-----------------------------------------|
| `target`       | Yes      | string | Recipient JID                           |
| `contactName`  | Yes      | string | Display name for the contact            |
| `contactPhone` | Yes      | string | Phone number for the contact            |
| `replyTo`      | No       | object | Quote a previous message (see [replyTo](#replyto-object)) |

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "contactName": "Jane Doe",
  "contactPhone": "+15559876543"
}
```

---

### `POST /send/location`

Send a location pin.

Body:

| Field       | Required | Type   | Description                                  |
|-------------|----------|--------|----------------------------------------------|
| `target`    | Yes      | string | Recipient JID                                |
| `latitude`  | Yes      | number | Decimal latitude                             |
| `longitude` | Yes      | number | Decimal longitude                            |
| `name`      | No       | string | Location name shown above the pin            |
| `address`   | No       | string | Address line shown below the name            |
| `replyTo`   | No       | object | Quote a previous message (see [replyTo](#replyto-object)) |

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "name": "San Francisco",
  "address": "San Francisco, CA, USA"
}
```

---

### `POST /send/poll`

Send a poll message.

Body:

| Field             | Required | Type     | Description                              |
|-------------------|----------|----------|------------------------------------------|
| `target`          | Yes      | string   | Recipient JID                            |
| `pollText`        | Yes      | string   | Poll question                            |
| `pollOptions`     | Yes      | string[] | At least 2 non-empty options             |
| `multipleAnswers` | No       | boolean  | `true` to allow selecting multiple options (default `false`) |
| `replyTo`         | No       | object   | Quote a previous message (see [replyTo](#replyto-object)) |

Example body:

```json
{
  "target": "1203630XXXXXXXXX@g.us",
  "pollText": "Where should we meet?",
  "pollOptions": ["Office", "Cafe", "Remote"]
}
```

---

### `replyTo` Object

All send endpoints accept an optional `replyTo` field to quote a previous message. WhatsApp will display the quoted bubble above your new message.

| Field        | Required | Type    | Description                                                             |
|--------------|----------|---------|-------------------------------------------------------------------------|
| `id`         | Yes      | string  | Message ID (`key.id`) of the message to quote                          |
| `fromMe`     | No       | boolean | Whether the quoted message was sent by this account (default `false`)  |
| `remoteJid`  | No       | string  | JID of the chat the quoted message belongs to (defaults to `target`)   |
| `participant`| No       | string  | Sender JID — required when quoting a message in a group that isn't yours |
| `message`    | No       | object  | Original message content object for the quoted preview bubble. If omitted, an empty preview is shown. |

Minimal example (reply in a DM):

```json
{
  "id": "ABCDEF1234567890",
  "fromMe": false
}
```

Group reply (quoting someone else):

```json
{
  "id": "ABCDEF1234567890",
  "fromMe": false,
  "remoteJid": "1203630XXXXXXXXX@g.us",
  "participant": "15559876543@s.whatsapp.net",
  "message": { "conversation": "The original message text" }
}
```

---

### `POST /group/participants/remove`

Remove participants from a group. Requires the connected number to be a group admin.

Body:

| Field          | Required | Type     | Description                              |
|----------------|----------|----------|------------------------------------------|
| `groupId`      | Yes      | string   | JID of the group (e.g. `123@g.us`)       |
| `participants` | Yes      | string[] | Array of JIDs to remove                  |

Example body:

```json
{
  "groupId": "1203630XXXXXXXXX@g.us",
  "participants": ["15551234567@s.whatsapp.net"]
}
```

---

### `GET /contact`

Check if a number exists on WhatsApp and retrieve its JID.

Query params:

| Param    | Required | Description         |
|----------|----------|---------------------|
| `target` | Yes      | Phone number or JID |

Returns `404` if the number is not registered on WhatsApp.

Example:

```bash
curl -H "x-api-key: YOUR_KEY" \
  "http://localhost:3000/contact?target=15551234567@s.whatsapp.net"
```

Example response:

```json
{
  "ok": true,
  "result": {
    "jid": "15551234567@s.whatsapp.net",
    "exists": true
  }
}
```

---

### `POST /contact/block`

Block a contact.

Body:

| Field    | Required | Type   | Description         |
|----------|----------|--------|---------------------|
| `target` | Yes      | string | JID of the contact  |

Example body:

```json
{ "target": "15551234567@s.whatsapp.net" }
```

---

### `POST /contact/unblock`

Unblock a contact.

Body:

| Field    | Required | Type   | Description         |
|----------|----------|--------|---------------------|
| `target` | Yes      | string | JID of the contact  |

Example body:

```json
{ "target": "15551234567@s.whatsapp.net" }
```

---

### `POST /group/create`

Create a new WhatsApp group.

Body:

| Field          | Required | Type     | Description                                      |
|----------------|----------|----------|--------------------------------------------------|
| `name`         | Yes      | string   | Group subject/name                               |
| `participants` | Yes      | string[] | Array of JIDs to add (must include at least one) |

Example body:

```json
{
  "name": "Project Team",
  "participants": ["15551234567@s.whatsapp.net", "15559876543@s.whatsapp.net"]
}
```

Example response:

```json
{
  "ok": true,
  "result": {
    "name": "Project Team",
    "participants": ["15551234567@s.whatsapp.net", "15559876543@s.whatsapp.net"],
    "groupId": "1203630XXXXXXXXX@g.us"
  }
}
```

---

### `POST /group/join`

Join a group via an invite link or code.

Body:

| Field        | Required | Type   | Description                                                        |
|--------------|----------|--------|--------------------------------------------------------------------|
| `inviteCode` | Yes      | string | Full invite URL (`https://chat.whatsapp.com/XYZ`) or just the code |

Example body:

```json
{
  "inviteCode": "https://chat.whatsapp.com/AbCdEfGhIjK"
}
```

---

### `GET /group/list`

Returns all groups the connected number is currently participating in.

No body required.

Example response:

```json
{
  "ok": true,
  "result": {
    "groups": [
      {
        "id": "1203630XXXXXXXXX@g.us",
        "subject": "Project Team",
        "creation": 1700000000,
        "owner": "15551234567@s.whatsapp.net",
        "participantCount": 5
      }
    ]
  }
}
```

---

### `POST /group/participants/add`

Add participants to an existing group. Requires the connected number to be a group admin.

Body:

| Field          | Required | Type     | Description                              |
|----------------|----------|----------|------------------------------------------|
| `groupId`      | Yes      | string   | JID of the group (e.g. `123@g.us`)       |
| `participants` | Yes      | string[] | Array of JIDs to add                     |

Example body:

```json
{
  "groupId": "1203630XXXXXXXXX@g.us",
  "participants": ["15551234567@s.whatsapp.net"]
}
```

---

### `POST /message/delete`

Delete a message (for everyone, if permitted by WhatsApp).

Body:

| Field         | Required | Type    | Description                                                              |
|---------------|----------|---------|--------------------------------------------------------------------------|
| `target`      | Yes      | string  | JID of the chat the message belongs to                                   |
| `messageId`   | Yes      | string  | The `key.id` of the message to delete                                    |
| `fromMe`      | Yes      | boolean | `true` if the message was sent by this account                           |
| `participant` | No       | string  | Sender JID — **required for group messages where `fromMe` is `false`**   |

Example body:

```json
{
  "target": "15551234567@s.whatsapp.net",
  "messageId": "ABCDEF1234567890",
  "fromMe": true
}
```

Group message (not sent by you):

```json
{
  "target": "1203630XXXXXXXXX@g.us",
  "messageId": "ABCDEF1234567890",
  "fromMe": false,
  "participant": "15559876543@s.whatsapp.net"
}
```

**Notes:**
- Delete for everyone only works on your own messages within approximately 60 hours of sending. After that it silently becomes delete-for-me only.
- Group admins can delete any message in their group.
- `participant` must be provided for group messages you did not send, otherwise WhatsApp cannot locate the message.

---

## Webhook Events

If `webhook_url` is configured in the `wa_numbers` table, the service POSTs every event as JSON to that URL. Delivery is retried with exponential backoff and persisted to the `wa_webhook_queue` table so undelivered events survive a process restart.

Key event types:

| Event type                  | Description                                       |
|-----------------------------|---------------------------------------------------|
| `connection.open`           | WhatsApp connected successfully                   |
| `connection.close`          | Disconnected; reconnect scheduled if transient    |
| `connection.dead`           | Max reconnect attempts exceeded; restart required |
| `auth.qr.updated`           | New QR code available                             |
| `auth.logged_out`           | Device removed; auth cleared, QR flow restarted   |
| `messages.upsert`           | Incoming or sent message                          |
| `messages.update`           | Message status update (delivered, read, etc.)     |
| `message-receipt.update`    | Delivery receipt                                  |
| `message.delete`            | Message deleted via API                           |
| `send.text`                 | Outbound text sent                                |
| `send.media`                | Outbound media sent                               |
| `send.poll`                 | Outbound poll sent                                |
| `send.contact`              | Outbound contact card sent                        |
| `send.location`             | Outbound location pin sent                        |
| `group.create`              | Group created via API                             |
| `group.join`                | Group joined via invite code                      |
| `group.participants.add`    | Participants added to a group via API             |
| `group.participants.remove` | Participants removed from a group via API         |
| `contact.block`             | Contact blocked via API                           |
| `contact.unblock`           | Contact unblocked via API                         |
| `presence.update`           | Contact online/offline presence                   |
| `groups.upsert`             | New group created or joined                       |
| `groups.update`             | Group metadata changed                            |
| `group-participants.update` | Group membership changed                          |

---

## Quick Start (Docker Compose)

1. Set up the database — see [INSTALL.md](./INSTALL.md).

2. Copy and fill in env file:

```bash
cp .env.example .env
```

3. Start the service:

```bash
docker compose up -d --build
```

4. Call the health endpoint:

```bash
curl -H "x-api-key: YOUR_KEY" http://localhost:3000/health
```

5. Scan the QR code printed in the terminal (or fetch it via `GET /auth/qr`).
