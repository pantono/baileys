'use strict';

require('dotenv').config();

const express = require('express');
const {
  createWhatsAppService,
  readEventsBetween,
  parseDateInput,
} = require('../utils/baileys');
const db = require('../utils/db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JSON_LIMIT = process.env.JSON_LIMIT || '25mb';
const API_KEY = process.env.API_KEY || '';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';

if (!WHATSAPP_NUMBER) {
  console.error('WHATSAPP_NUMBER is required. Set it in your .env file.');
  process.exit(1);
}

// API layer only: all WhatsApp socket behavior is encapsulated in utils/baileys.js
const app = express();
app.use(express.json({ limit: JSON_LIMIT }));

function log(message, extra) {
  const ts = new Date().toISOString();
  if (extra) {
    console.log(`[${ts}] ${message}`, extra);
    return;
  }
  console.log(`[${ts}] ${message}`);
}

function getApiKeyFromRequest(req) {
  const headerKey = req.header('x-api-key');
  if (headerKey) {
    return headerKey.trim();
  }

  const auth = req.header('authorization') || '';
  const [scheme, token] = auth.split(' ');
  if (scheme && token && scheme.toLowerCase() === 'bearer') {
    return token.trim();
  }

  return '';
}

// Protect all API routes with a shared API key.
app.use((req, res, next) => {
  const providedKey = getApiKeyFromRequest(req);
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return;
  }
  next();
});

// whatsapp service instance — initialised in start()
let whatsapp = null;

app.get('/health', async (req, res) => {
  const state = whatsapp.getState();

  let dbOk = false;
  try {
    await db.pingDb();
    dbOk = true;
  } catch (_) {
    // db unavailable — reported in response
  }

  const mem = process.memoryUsage();
  const ok = dbOk && !state.dead;

  res.status(ok ? 200 : 503).json({
    ok,
    service: 'baileys-rest-service',
    now: new Date().toISOString(),
    whatsapp: {
      connected: state.connected,
      dead: state.dead,
      lastDisconnectReason: state.lastDisconnectReason,
      reconnectAttempts: state.reconnectAttempts,
      hasQr: Boolean(state.currentQr),
      me: state.me,
      webhookQueueSize: state.webhookQueueSize,
      eventBufferSize: state.eventBufferSize,
    },
    db: { ok: dbOk },
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
    },
  });
});

app.get('/auth/qr', async (req, res) => {
  const state = whatsapp.getState();

  if (!state.currentQr) {
    res.status(404).json({
      ok: false,
      message: 'No QR code currently available. The session may already be authenticated.',
      connected: state.connected,
    });
    return;
  }

  res.json({
    ok: true,
    connected: state.connected,
    qr: state.currentQr,
    qrDataUrl: state.currentQrDataUrl,
    updatedAt: state.qrUpdatedAt,
  });
});

app.get('/events', async (req, res) => {
  const startDate = parseDateInput(req.query.start_date, 'start_date');
  const endDate = parseDateInput(req.query.end_date, 'end_date');

  if (startDate.error || endDate.error) {
    res.status(400).json({
      ok: false,
      message: startDate.error || endDate.error,
      expected: {
        start_date: 'ISO-8601 date-time, e.g. 2026-02-13T00:00:00.000Z',
        end_date: 'ISO-8601 date-time, e.g. 2026-02-13T23:59:59.999Z',
      },
    });
    return;
  }

  if (!startDate.value || !endDate.value) {
    res.status(400).json({
      ok: false,
      message: 'Both start_date and end_date are required query params.',
    });
    return;
  }

  if (startDate.value > endDate.value) {
    res.status(400).json({
      ok: false,
      message: 'start_date must be less than or equal to end_date.',
    });
    return;
  }

  const events = await readEventsBetween(WHATSAPP_NUMBER, startDate.value, endDate.value);
  res.json({
    ok: true,
    count: events.length,
    start_date: startDate.value.toISOString(),
    end_date: endDate.value.toISOString(),
    events,
  });
});

app.post('/auth/reset', async (req, res, next) => {
  try {
    await whatsapp.stop();
    await whatsapp.start({ forceNewLogin: true });

    res.json({
      ok: true,
      message: 'Authentication state cleared. Re-authentication required.',
    });
  } catch (error) {
    next(error);
  }
});

app.post('/send/text', async (req, res, next) => {
  try {
    const { target, message, replyTo } = req.body || {};
    const result = await whatsapp.sendText({ target, message, replyTo });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/media', async (req, res, next) => {
  try {
    const { target, base64, filename, mimetype, message, replyTo } = req.body || {};
    const result = await whatsapp.sendMedia({ target, base64, filename, mimetype, message, replyTo });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/contact', async (req, res, next) => {
  try {
    const { target, contactName, contactPhone, replyTo } = req.body || {};
    const result = await whatsapp.sendContact({ target, contactName, contactPhone, replyTo });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/location', async (req, res, next) => {
  try {
    const { target, latitude, longitude, name, address, replyTo } = req.body || {};
    const result = await whatsapp.sendLocation({ target, latitude, longitude, name, address, replyTo });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/poll', async (req, res, next) => {
  try {
    const { target, pollText, pollOptions, multipleAnswers, replyTo } = req.body || {};
    const result = await whatsapp.sendPoll({ target, pollText, pollOptions, multipleAnswers, replyTo });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/group/create', async (req, res, next) => {
  try {
    const { name, participants } = req.body || {};
    const result = await whatsapp.createGroup({ name, participants });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/group/join', async (req, res, next) => {
  try {
    const { inviteCode } = req.body || {};
    const result = await whatsapp.joinGroup({ inviteCode });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.get('/group/list', async (req, res, next) => {
  try {
    const result = await whatsapp.listGroups();
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/group/participants/add', async (req, res, next) => {
  try {
    const { groupId, participants } = req.body || {};
    const result = await whatsapp.addGroupParticipants({ groupId, participants });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/group/participants/remove', async (req, res, next) => {
  try {
    const { groupId, participants } = req.body || {};
    const result = await whatsapp.removeGroupParticipants({ groupId, participants });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.get('/contact', async (req, res, next) => {
  try {
    const target = req.query.target;
    const result = await whatsapp.getContact({ target });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/contact/block', async (req, res, next) => {
  try {
    const { target } = req.body || {};
    const result = await whatsapp.blockContact({ target });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/contact/unblock', async (req, res, next) => {
  try {
    const { target } = req.body || {};
    const result = await whatsapp.unblockContact({ target });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/message/delete', async (req, res, next) => {
  try {
    const { target, messageId, fromMe, participant } = req.body || {};
    const result = await whatsapp.deleteMessage({ target, messageId, fromMe, participant });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  log('Request failed', {
    method: req.method,
    path: req.path,
    status,
    error: error.message,
  });

  res.status(status).json({
    ok: false,
    message: error.message || 'Internal server error',
  });
});

async function waitForDb(maxAttempts = 10, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.pingDb();
      log('Database connection established');
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Database unavailable after ${maxAttempts} attempts: ${error.message}`);
      }
      const delay = Math.min(30000, baseDelayMs * (2 ** (attempt - 1)));
      log(`Database unavailable (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
        error: error.message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function start() {
  await waitForDb();

  // Load per-number config from DB; create row with defaults on first run.
  let numberConfig = await db.getNumberConfig(WHATSAPP_NUMBER);
  if (!numberConfig) {
    log(`No config found for ${WHATSAPP_NUMBER}, creating with defaults`);
    await db.upsertNumberConfig(WHATSAPP_NUMBER, {});
    numberConfig = await db.getNumberConfig(WHATSAPP_NUMBER);
  }

  const config = {
    webhookUrl:              numberConfig.webhook_url             || '',
    webhookTimeoutMs:        numberConfig.webhook_timeout_ms,
    webhookMaxRetries:       numberConfig.webhook_max_retries,
    webhookRetryBaseMs:      numberConfig.webhook_retry_base_ms,
    webhookRetryMaxMs:       numberConfig.webhook_retry_max_ms,
    eventRetention:          numberConfig.event_retention,
    reconnectBaseMs:         numberConfig.reconnect_base_ms,
    reconnectMaxMs:          numberConfig.reconnect_max_ms,
    fullHistoryOnReconnect:  Boolean(numberConfig.full_history_on_reconnect),
  };

  log(`Loaded config for ${WHATSAPP_NUMBER}`, config);

  whatsapp = createWhatsAppService({ phoneNumber: WHATSAPP_NUMBER, config, log });
  await whatsapp.start();

  app.listen(PORT, HOST, () => {
    log(`HTTP server listening on ${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  log('Fatal startup error', error);
  process.exit(1);
});

async function shutdown() {
  if (whatsapp) await whatsapp.stop();
  await db.closePool();
}

process.on('SIGINT', async () => {
  log('SIGINT received, shutting down');
  setTimeout(() => {
    log('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('SIGTERM received, shutting down');
  setTimeout(() => {
    log('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
  await shutdown();
  process.exit(0);
});
