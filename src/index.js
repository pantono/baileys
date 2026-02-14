'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const {
  createWhatsAppService,
  readEventsBetween,
  parseDateInput,
} = require('../utils/baileys');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const JSON_LIMIT = process.env.JSON_LIMIT || '25mb';

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

const whatsapp = createWhatsAppService({ dataDir: DATA_DIR, log });

app.get('/health', async (req, res) => {
  const state = whatsapp.getState();
  res.json({
    ok: true,
    service: 'baileys-rest-service',
    now: new Date().toISOString(),
    whatsapp: {
      connected: state.connected,
      lastDisconnectReason: state.lastDisconnectReason,
      reconnectAttempts: state.reconnectAttempts,
      hasQr: Boolean(state.currentQr),
      me: state.me,
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

  const events = await readEventsBetween(DATA_DIR, startDate.value, endDate.value);
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
    const { target, message } = req.body || {};
    const result = await whatsapp.sendText({ target, message });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/media', async (req, res, next) => {
  try {
    const { target, base64, filename, mimetype } = req.body || {};
    const result = await whatsapp.sendMedia({ target, base64, filename, mimetype });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/send/poll', async (req, res, next) => {
  try {
    const { target, pollText, pollOptions } = req.body || {};
    const result = await whatsapp.sendPoll({ target, pollText, pollOptions });
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

async function start() {
  await whatsapp.start();

  app.listen(PORT, () => {
    log(`HTTP server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  log('Fatal startup error', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  log('SIGINT received, shutting down');
  await whatsapp.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('SIGTERM received, shutting down');
  await whatsapp.stop();
  process.exit(0);
});
