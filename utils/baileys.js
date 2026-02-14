'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 8000);
const WEBHOOK_MAX_RETRIES = Number(process.env.WEBHOOK_MAX_RETRIES || 8);
const WEBHOOK_RETRY_BASE_MS = Number(process.env.WEBHOOK_RETRY_BASE_MS || 1000);
const WEBHOOK_RETRY_MAX_MS = Number(process.env.WEBHOOK_RETRY_MAX_MS || 30000);
const EVENT_RETENTION = Number(process.env.EVENT_RETENTION || 2000);
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 1500);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 30000);

const AUTH_DIR_NAME = 'auth';
const EVENTS_LOG_NAME = 'events.log';

function now() {
  return new Date().toISOString();
}

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function toSafeError(error) {
  if (!error) return null;
  return {
    message: error.message,
    stack: error.stack,
    name: error.name,
    statusCode: error.statusCode,
    output: error.output,
  };
}

function parseDateInput(value, key) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return { error: `Invalid ${key}. Use a valid ISO date string.` };
  }

  return { value: date };
}

function backoffMs(attempt, baseMs, maxMs) {
  const jitter = Math.floor(Math.random() * 200);
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxMs, raw + jitter);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendEvent(dataDir, event, log) {
  try {
    const line = `${JSON.stringify(event)}\n`;
    fs.appendFileSync(path.join(dataDir, EVENTS_LOG_NAME), line, 'utf8');
  } catch (error) {
    log('Failed to append event log', toSafeError(error));
  }
}

async function readEventsBetween(dataDir, startDate, endDate) {
  const eventFile = path.join(dataDir, EVENTS_LOG_NAME);
  if (!fs.existsSync(eventFile)) {
    return [];
  }

  const rows = fs.readFileSync(eventFile, 'utf8').split('\n').filter(Boolean);
  const events = [];

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row);
      const ts = new Date(parsed.timestamp);
      if (Number.isNaN(ts.getTime())) {
        continue;
      }
      if (ts >= startDate && ts <= endDate) {
        events.push(parsed);
      }
    } catch (error) {
      // Ignore corrupt lines so one bad row does not break the API.
    }
  }

  return events;
}

async function resetAuthState(dataDir, log) {
  const authDir = path.join(dataDir, AUTH_DIR_NAME);
  ensureDir(authDir);

  for (const entry of fs.readdirSync(authDir)) {
    const fullPath = path.join(authDir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }

    fs.unlinkSync(fullPath);
  }

  log('Auth state reset completed', { authDir });
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'string') {
    const error = new Error('target is required and must be a WhatsApp JID string.');
    error.statusCode = 400;
    throw error;
  }

  return target.trim();
}

function throwBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function makeWebhookDispatcher(log) {
  const queue = [];
  let running = false;

  // Single-flight retry queue with exponential backoff keeps webhook delivery
  // ordered and resilient against transient downstream failures.
  async function postJson(url, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': crypto.randomUUID(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Webhook responded with ${response.status}: ${text.slice(0, 300)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run() {
    if (running) return;
    running = true;

    while (queue.length > 0) {
      const item = queue[0];
      try {
        await postJson(item.url, item.payload);
        queue.shift();
      } catch (error) {
        item.attempt += 1;
        if (item.attempt > WEBHOOK_MAX_RETRIES) {
          log('Webhook dropped after max retries', {
            eventType: item.payload?.eventType,
            error: toSafeError(error),
          });
          queue.shift();
          continue;
        }

        const delay = backoffMs(item.attempt, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS);
        log('Webhook failed, retrying', {
          attempt: item.attempt,
          delayMs: delay,
          eventType: item.payload?.eventType,
          error: toSafeError(error),
        });
        await sleep(delay);
      }
    }

    running = false;
  }

  function enqueue(payload) {
    if (!WEBHOOK_URL) {
      return;
    }

    queue.push({
      url: WEBHOOK_URL,
      payload,
      attempt: 0,
      enqueuedAt: now(),
    });

    void run();
  }

  return {
    enqueue,
    getQueueSize: () => queue.length,
  };
}

function createWhatsAppService({ dataDir, log }) {
  // Data layout:
  // - /data/auth/*       : Baileys multi-file auth state
  // - /data/events.log   : JSONL event stream for diagnostics + /events API
  ensureDir(dataDir);

  const authDir = path.join(dataDir, AUTH_DIR_NAME);
  ensureDir(authDir);

  const webhook = makeWebhookDispatcher(log);

  let socket = null;
  let connected = false;
  let currentQr = null;
  let currentQrDataUrl = null;
  let qrUpdatedAt = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let lastDisconnectReason = null;
  let me = null;

  const eventBuffer = [];

  function pushEvent(eventType, payload) {
    const event = {
      timestamp: now(),
      eventType,
      payload,
    };

    eventBuffer.push(event);
    if (eventBuffer.length > EVENT_RETENTION) {
      eventBuffer.shift();
    }

    appendEvent(dataDir, event, log);
    webhook.enqueue(event);
  }

  async function connect(forceNewLogin = false) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (forceNewLogin) {
      await resetAuthState(dataDir, log);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const socketConfig = {
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      browser: ['Baileys REST Service', 'Chrome', '1.0.0'],
    };

    try {
      const { version } = await fetchLatestBaileysVersion();
      socketConfig.version = version;
    } catch (error) {
      // Continue with Baileys defaults if version lookup fails.
      log('Failed to fetch latest Baileys version, using default', toSafeError(error));
    }

    socket = makeWASocket(socketConfig);

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        log('Failed to save creds', toSafeError(error));
      }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        qrUpdatedAt = now();
        currentQrDataUrl = await qrcode.toDataURL(qr).catch(() => null);
        log('QR updated, scan required');
        pushEvent('auth.qr.updated', {
          qrUpdatedAt,
        });
      }

      if (connection === 'open') {
        connected = true;
        reconnectAttempts = 0;
        lastDisconnectReason = null;
        currentQr = null;
        currentQrDataUrl = null;
        qrUpdatedAt = null;

        me = socket?.user || null;
        log('WhatsApp connected', { me });
        pushEvent('connection.open', { me });
      }

      if (connection === 'close') {
        connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = statusCode || 'unknown';

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        log('WhatsApp disconnected', {
          statusCode,
          shouldReconnect,
          lastDisconnect: toSafeError(lastDisconnect?.error),
        });
        pushEvent('connection.close', {
          statusCode,
          shouldReconnect,
        });

        if (shouldReconnect) {
          reconnectAttempts += 1;
          const delay = backoffMs(reconnectAttempts, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
          log('Scheduling reconnect', {
            reconnectAttempts,
            delay,
          });

          reconnectTimer = setTimeout(() => {
            void connect(false).catch((error) => {
              log('Reconnect attempt failed', toSafeError(error));
            });
          }, delay);
        }
      }
    });

    socket.ev.on('messages.upsert', ({ type, messages }) => {
      for (const msg of messages || []) {
        const record = {
          type,
          key: msg.key,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName,
          message: msg.message,
        };

        log('Incoming message event', {
          remoteJid: msg.key?.remoteJid,
          id: msg.key?.id,
          fromMe: msg.key?.fromMe,
          type,
        });

        pushEvent('messages.upsert', record);
      }
    });

    socket.ev.on('messages.update', (updates) => {
      for (const update of updates || []) {
        log('Message status update', {
          key: update.key,
          update: update.update,
        });

        pushEvent('messages.update', update);
      }
    });

    socket.ev.on('message-receipt.update', (receipts) => {
      for (const receipt of receipts || []) {
        log('Delivery receipt update', receipt);
        pushEvent('message-receipt.update', receipt);
      }
    });
  }

  async function ensureConnected() {
    if (!socket || !connected) {
      const error = new Error('WhatsApp is not connected. Authenticate first and wait for connection.open.');
      error.statusCode = 503;
      throw error;
    }
  }

  return {
    async start(options = {}) {
      await connect(Boolean(options.forceNewLogin));
      log('WhatsApp service initialized');
    },

    async stop() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (socket?.ws) {
        socket.ws.close();
      }

      socket = null;
      connected = false;
      log('WhatsApp service stopped');
    },

    getState() {
      return {
        connected,
        currentQr,
        currentQrDataUrl,
        qrUpdatedAt,
        reconnectAttempts,
        lastDisconnectReason,
        me,
        webhookQueueSize: webhook.getQueueSize(),
      };
    },

    async sendText({ target, message }) {
      const jid = normalizeTarget(target);
      if (!message || typeof message !== 'string') {
        throwBadRequest('message is required and must be a string.');
      }
      await ensureConnected();

      const sent = await socket.sendMessage(jid, { text: message });
      pushEvent('send.text', { jid, sent });
      return { jid, sent };
    },

    async sendMedia({ target, base64, filename, mimetype }) {
      const jid = normalizeTarget(target);
      if (!base64 || typeof base64 !== 'string') {
        throwBadRequest('base64 is required and must be a base64 string.');
      }
      if (!filename || typeof filename !== 'string') {
        throwBadRequest('filename is required and must be a string.');
      }
      if (!mimetype || typeof mimetype !== 'string') {
        throwBadRequest('mimetype is required and must be a string.');
      }

      await ensureConnected();
      const buffer = Buffer.from(base64, 'base64');
      const sent = await socket.sendMessage(jid, {
        document: buffer,
        fileName: filename,
        mimetype,
      });

      pushEvent('send.media', {
        jid,
        fileName: filename,
        mimetype,
        messageId: sent?.key?.id,
      });

      return {
        jid,
        fileName: filename,
        mimetype,
        sent,
      };
    },

    async sendPoll({ target, pollText, pollOptions }) {
      const jid = normalizeTarget(target);
      if (!pollText || typeof pollText !== 'string') {
        throwBadRequest('pollText is required and must be a string.');
      }
      if (!Array.isArray(pollOptions) || pollOptions.length < 2) {
        throwBadRequest('pollOptions is required and must be an array with at least 2 options.');
      }

      await ensureConnected();

      const options = pollOptions
        .map((option) => String(option).trim())
        .filter(Boolean);

      if (options.length < 2) {
        throwBadRequest('pollOptions must contain at least 2 non-empty options.');
      }

      const sent = await socket.sendMessage(jid, {
        poll: {
          name: pollText,
          values: options,
          selectableCount: 1,
        },
      });

      pushEvent('send.poll', {
        jid,
        pollText,
        options,
        messageId: sent?.key?.id,
      });

      return {
        jid,
        pollText,
        options,
        sent,
      };
    },
  };
}

module.exports = {
  createWhatsAppService,
  parseDateInput,
  readEventsBetween,
  resetAuthState,
};
