'use strict';

const crypto = require('crypto');
const qrcode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const db = require('./db');
const { useMySQLAuthState } = require('./auth');

function now() {
  return new Date().toISOString();
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

async function readEventsBetween(phoneNumber, startDate, endDate) {
  return db.queryEventsBetween(phoneNumber, startDate, endDate);
}

function buildQuoted(replyTo, jid) {
  if (!replyTo) return undefined;
  if (typeof replyTo !== 'object' || Array.isArray(replyTo)) {
    const error = new Error('replyTo must be an object.');
    error.statusCode = 400;
    throw error;
  }
  if (!replyTo.id || typeof replyTo.id !== 'string') {
    const error = new Error('replyTo.id is required and must be a string.');
    error.statusCode = 400;
    throw error;
  }
  return {
    key: {
      remoteJid: (replyTo.remoteJid && typeof replyTo.remoteJid === 'string')
        ? replyTo.remoteJid.trim()
        : jid,
      fromMe: Boolean(replyTo.fromMe),
      id: replyTo.id.trim(),
      ...(replyTo.participant && typeof replyTo.participant === 'string'
        ? { participant: replyTo.participant.trim() }
        : {}),
    },
    message: replyTo.message && typeof replyTo.message === 'object'
      ? replyTo.message
      : { conversation: '' },
  };
}

const MAX_WEBHOOK_QUEUE_SIZE = 500;
const MAX_RECONNECT_ATTEMPTS = 20;

function makeWebhookDispatcher(config, log, db, phoneNumber) {
  let webhookTimeoutMs = config.webhookTimeoutMs;
  let webhookMaxRetries = config.webhookMaxRetries;
  let webhookRetryBaseMs = config.webhookRetryBaseMs;
  let webhookRetryMaxMs = config.webhookRetryMaxMs;

  let targets = config.targets || [];

  const queue = [];
  let running = false;

  async function init() {
    if (!targets.length) return;
    try {
      const items = await db.loadPendingWebhookItems(phoneNumber);
      for (const item of items) {
        if (item.url) {
          queue.push(item);
        }
      }
      if (queue.length > 0) {
        log(`Loaded ${queue.length} pending webhook items from DB`);
        void run();
      }
    } catch (error) {
      log('Failed to load pending webhook items from DB', toSafeError(error));
    }
  }

  async function postJson(url, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhookTimeoutMs);

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
        if (item.dbId != null) {
          db.deleteWebhookQueueItem(item.dbId).catch((error) => {
            log('Failed to delete delivered webhook queue item from DB', toSafeError(error));
          });
        }
        queue.shift();
      } catch (error) {
        item.attempt += 1;
        if (item.attempt > webhookMaxRetries) {
          log('Webhook dropped after max retries', {
            eventType: item.payload?.eventType,
            error: toSafeError(error),
          });
          if (item.dbId != null) {
            db.deleteWebhookQueueItem(item.dbId).catch((err) => {
              log('Failed to delete dropped webhook queue item from DB', toSafeError(err));
            });
          }
          queue.shift();
          continue;
        }

        const delay = backoffMs(item.attempt, webhookRetryBaseMs, webhookRetryMaxMs);
        if (item.dbId != null) {
          const nextRetryAt = new Date(Date.now() + delay).toISOString();
          db.updateWebhookQueueItem(item.dbId, item.attempt, nextRetryAt).catch((err) => {
            log('Failed to update webhook queue item in DB', toSafeError(err));
          });
        }
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
    if (!targets.length) {
      return;
    }

    const enqueuedAt = now();

    for (const target of targets) {
      if (queue.length >= MAX_WEBHOOK_QUEUE_SIZE) {
        const evicted = queue.shift();
        log('Webhook queue full, evicting oldest item', { eventType: evicted.payload?.eventType, url: evicted.url });
        if (evicted.dbId != null) {
          db.deleteWebhookQueueItem(evicted.dbId).catch((error) => {
            log('Failed to evict webhook queue item from DB', toSafeError(error));
          });
        }
      }

      db.insertWebhookQueueItem(phoneNumber, target.url, payload, enqueuedAt)
        .then((dbId) => {
          queue.push({ dbId, url: target.url, payload, attempt: 0, enqueuedAt });
          void run();
        })
        .catch((error) => {
          log('Failed to persist webhook item to DB, enqueuing in-memory only', toSafeError(error));
          queue.push({ dbId: null, url: target.url, payload, attempt: 0, enqueuedAt });
          void run();
        });
    }
  }

  return {
    enqueue,
    init,
    getQueueSize: () => queue.length,
    setTargets: (newTargets) => { targets = newTargets; },
    setDispatcherConfig: (newConfig) => {
      if (newConfig.webhookTimeoutMs !== undefined) webhookTimeoutMs = newConfig.webhookTimeoutMs;
      if (newConfig.webhookMaxRetries !== undefined) webhookMaxRetries = newConfig.webhookMaxRetries;
      if (newConfig.webhookRetryBaseMs !== undefined) webhookRetryBaseMs = newConfig.webhookRetryBaseMs;
      if (newConfig.webhookRetryMaxMs !== undefined) webhookRetryMaxMs = newConfig.webhookRetryMaxMs;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.phoneNumber   - WhatsApp number identifying this instance
 * @param {object} options.config        - Per-number config loaded from wa_numbers table
 * @param {Function} options.log
 */
function createWhatsAppService({ phoneNumber, config, log }) {
  let webhookTimeoutMs = config.webhookTimeoutMs;
  let webhookMaxRetries = config.webhookMaxRetries;
  let webhookRetryBaseMs = config.webhookRetryBaseMs;
  let webhookRetryMaxMs = config.webhookRetryMaxMs;
  let eventRetention = config.eventRetention;
  let reconnectBaseMs = config.reconnectBaseMs;
  let reconnectMaxMs = config.reconnectMaxMs;
  let fullHistoryOnReconnect = config.fullHistoryOnReconnect;

  const webhook = makeWebhookDispatcher(
    { targets: config.webhookTargets || [], webhookTimeoutMs, webhookMaxRetries, webhookRetryBaseMs, webhookRetryMaxMs },
    log,
    db,
    phoneNumber
  );

  let socket = null;
  let connected = false;
  let dead = false;
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
    if (eventBuffer.length > eventRetention) {
      eventBuffer.shift();
    }

    db.insertEvent(phoneNumber, event).catch((error) => {
      log('Failed to insert event to DB', toSafeError(error));
    });

    webhook.enqueue(event);
  }

  async function connect(forceNewLogin = false) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (forceNewLogin) {
      await db.deleteAuthState(phoneNumber);
      log('Auth state reset completed', { phoneNumber });
    }

    const isReconnectAttempt = reconnectAttempts > 0;
    const shouldSyncFullHistory = fullHistoryOnReconnect && isReconnectAttempt;

    const { state, saveCreds } = await useMySQLAuthState(phoneNumber);
    const socketConfig = {
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: shouldSyncFullHistory,
      generateHighQualityLinkPreview: true,
      browser: ['Baileys REST Service', 'Chrome', '1.0.0'],
    };

    if (shouldSyncFullHistory) {
      log('Reconnect detected: enabling full history sync for this session', {
        reconnectAttempts,
      });
      pushEvent('history.resync.requested', {
        reconnectAttempts,
        syncFullHistory: true,
      });
    }

    try {
      const { version } = await fetchLatestBaileysVersion();
      socketConfig.version = version;
    } catch (error) {
      log('Failed to fetch latest Baileys version, using default', toSafeError(error));
    }

    socket = makeWASocket(socketConfig);

    socket.ev.on('creds.update', async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await saveCreds();
          break;
        } catch (error) {
          if (attempt < 3) {
            const delay = 500 * attempt;
            log(`Failed to save creds (attempt ${attempt}/3), retrying in ${delay}ms`, toSafeError(error));
            await sleep(delay);
          } else {
            log('Failed to save creds after 3 attempts — credentials may be stale on restart', toSafeError(error));
          }
        }
      }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        qrUpdatedAt = now();
        currentQrDataUrl = await qrcode.toDataURL(qr).catch(() => null);
        log('QR updated, scan required');
        pushEvent('auth.qr.updated', { qrUpdatedAt });
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

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;
        log('WhatsApp disconnected', {
          statusCode,
          shouldReconnect,
          lastDisconnect: toSafeError(lastDisconnect?.error),
        });
        pushEvent('connection.close', { statusCode, shouldReconnect });

        if (isLoggedOut) {
          log('Session logged out (device removed or deauthorised) — clearing auth state and restarting for QR re-auth');
          pushEvent('auth.logged_out', { statusCode });
          reconnectAttempts = 0;
          dead = false;
          db.deleteAuthState(phoneNumber)
            .catch((err) => log('Failed to clear auth state after logout', toSafeError(err)))
            .finally(() => {
              void connect(false).catch((error) => {
                log('Failed to restart after logout', toSafeError(error));
              });
            });
          return;
        }

        if (shouldReconnect) {
          reconnectAttempts += 1;

          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            dead = true;
            log('Max reconnect attempts reached, service is dead. Restart required.', {
              reconnectAttempts,
              MAX_RECONNECT_ATTEMPTS,
            });
            pushEvent('connection.dead', { reconnectAttempts, MAX_RECONNECT_ATTEMPTS });
            return;
          }

          const delay = backoffMs(reconnectAttempts, reconnectBaseMs, reconnectMaxMs);
          log('Scheduling reconnect', { reconnectAttempts, delay });

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
          raw_data: msg
        });

        pushEvent('messages.upsert', record);
      }
    });

    socket.ev.on('messages.update', (updates) => {
      for (const update of updates || []) {
        log('Message status update', { key: update.key, update: update.update });
        pushEvent('messages.update', update);
      }
    });

    socket.ev.on('message-receipt.update', (receipts) => {
      for (const receipt of receipts || []) {
        log('Delivery receipt update', receipt);
        pushEvent('message-receipt.update', receipt);
      }
    });

    const passthroughEvents = [
      'presence.update',
      'messaging-history.set',
      'groups.upsert',
      'groups.update',
      'group-participants.update',
      'group.join-request',
      'group.member-tag.update',
      'labels.edit',
      'labels.association',
      'lid-mapping.update',
      'settings.update',
      'messages.media-update',
    ];

    for (const eventName of passthroughEvents) {
      socket.ev.on(eventName, (payload) => {
        log(`Event received: ${eventName}`);
        pushEvent(eventName, payload);
      });
    }
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
      await webhook.init();
      await connect(Boolean(options.forceNewLogin));
      log('WhatsApp service initialized');
    },

    async reloadWebhookTargets() {
      const targets = await db.getWebhookTargets(phoneNumber);
      webhook.setTargets(targets);
      return targets;
    },

    reloadConfig(newConfig) {
      if (newConfig.eventRetention !== undefined) eventRetention = newConfig.eventRetention;
      if (newConfig.reconnectBaseMs !== undefined) reconnectBaseMs = newConfig.reconnectBaseMs;
      if (newConfig.reconnectMaxMs !== undefined) reconnectMaxMs = newConfig.reconnectMaxMs;
      if (newConfig.fullHistoryOnReconnect !== undefined) fullHistoryOnReconnect = newConfig.fullHistoryOnReconnect;
      if (newConfig.webhookTargets !== undefined) webhook.setTargets(newConfig.webhookTargets);
      webhook.setDispatcherConfig({
        webhookTimeoutMs: newConfig.webhookTimeoutMs,
        webhookMaxRetries: newConfig.webhookMaxRetries,
        webhookRetryBaseMs: newConfig.webhookRetryBaseMs,
        webhookRetryMaxMs: newConfig.webhookRetryMaxMs,
      });
      log('Config reloaded from database');
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
        dead,
        currentQr,
        currentQrDataUrl,
        qrUpdatedAt,
        reconnectAttempts,
        lastDisconnectReason,
        me,
        webhookQueueSize: webhook.getQueueSize(),
        eventBufferSize: eventBuffer.length,
      };
    },

    async sendText({ target, message, replyTo }) {
      const jid = normalizeTarget(target);
      if (!message || typeof message !== 'string') {
        throwBadRequest('message is required and must be a string.');
      }
      const quoted = buildQuoted(replyTo, jid);
      await ensureConnected();

      const sent = await socket.sendMessage(jid, { text: message }, { quoted });
      pushEvent('send.text', { jid, sent, replyToId: quoted?.key?.id });
      return { jid, sent };
    },

    async sendMedia({ target, base64, filename, mimetype, message, replyTo }) {
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
      const quoted = buildQuoted(replyTo, jid);
      await ensureConnected();

      const buffer = Buffer.from(base64, 'base64');
      const msgContent = { document: buffer, fileName: filename, mimetype };
      if (message && typeof message === 'string') {
        msgContent.caption = message;
      }
      const sent = await socket.sendMessage(
        jid,
        msgContent,
        { quoted }
      );

      pushEvent('send.media', { jid, fileName: filename, mimetype, messageId: sent?.key?.id, replyToId: quoted?.key?.id });

      return { jid, fileName: filename, mimetype, sent };
    },

    async sendPoll({ target, pollText, pollOptions, multipleAnswers, replyTo }) {
      const jid = normalizeTarget(target);
      if (!pollText || typeof pollText !== 'string') {
        throwBadRequest('pollText is required and must be a string.');
      }
      if (!Array.isArray(pollOptions) || pollOptions.length < 2) {
        throwBadRequest('pollOptions is required and must be an array with at least 2 options.');
      }
      const quoted = buildQuoted(replyTo, jid);
      await ensureConnected();

      const options = pollOptions.map((option) => String(option).trim()).filter(Boolean);
      if (options.length < 2) {
        throwBadRequest('pollOptions must contain at least 2 non-empty options.');
      }

      const selectableCount = multipleAnswers === true ? 0 : 1;
      const sent = await socket.sendMessage(
        jid,
        { poll: { name: pollText, values: options, selectableCount } },
        { quoted }
      );

      pushEvent('send.poll', { jid, pollText, options, messageId: sent?.key?.id, replyToId: quoted?.key?.id });

      return { jid, pollText, options, sent };
    },

    async sendContact({ target, contactName, contactPhone, replyTo }) {
      const jid = normalizeTarget(target);
      if (!contactName || typeof contactName !== 'string') {
        throwBadRequest('contactName is required and must be a string.');
      }
      if (!contactPhone || typeof contactPhone !== 'string') {
        throwBadRequest('contactPhone is required and must be a string.');
      }
      const quoted = buildQuoted(replyTo, jid);
      await ensureConnected();

      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, '')}:${contactPhone}\nEND:VCARD`;
      const sent = await socket.sendMessage(
        jid,
        { contacts: { displayName: contactName, contacts: [{ vcard }] } },
        { quoted }
      );

      pushEvent('send.contact', { jid, contactName, contactPhone, messageId: sent?.key?.id, replyToId: quoted?.key?.id });

      return { jid, contactName, contactPhone, sent };
    },

    async sendLocation({ target, latitude, longitude, name, address, replyTo }) {
      const jid = normalizeTarget(target);
      if (typeof latitude !== 'number') {
        throwBadRequest('latitude is required and must be a number.');
      }
      if (typeof longitude !== 'number') {
        throwBadRequest('longitude is required and must be a number.');
      }
      const quoted = buildQuoted(replyTo, jid);
      await ensureConnected();

      const locationMsg = { location: { degreesLatitude: latitude, degreesLongitude: longitude } };
      if (name && typeof name === 'string') locationMsg.location.name = name;
      if (address && typeof address === 'string') locationMsg.location.address = address;

      const sent = await socket.sendMessage(jid, locationMsg, { quoted });

      pushEvent('send.location', { jid, latitude, longitude, messageId: sent?.key?.id, replyToId: quoted?.key?.id });

      return { jid, latitude, longitude, sent };
    },

    async createGroup({ name, participants }) {
      if (!name || typeof name !== 'string') {
        throwBadRequest('name is required and must be a string.');
      }
      if (!Array.isArray(participants) || participants.length === 0) {
        throwBadRequest('participants is required and must be a non-empty array of JIDs.');
      }
      await ensureConnected();

      const result = await socket.groupCreate(name, participants.map((p) => String(p).trim()));
      pushEvent('group.create', { name, participants, groupId: result?.id });
      return { name, participants, groupId: result?.id, result };
    },

    async joinGroup({ inviteCode }) {
      if (!inviteCode || typeof inviteCode !== 'string') {
        throwBadRequest('inviteCode is required and must be a string.');
      }
      await ensureConnected();

      // Accept either a full invite URL or just the code
      const code = inviteCode.trim().replace(/.*chat\.whatsapp\.com\//, '');
      const groupId = await socket.groupAcceptInvite(code);
      pushEvent('group.join', { inviteCode: code, groupId });
      return { inviteCode: code, groupId };
    },

    async listGroups() {
      await ensureConnected();

      const groups = await socket.groupFetchAllParticipating();
      const list = Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
        creation: g.creation,
        owner: g.owner,
        participantCount: g.participants?.length ?? 0,
      }));
      return { groups: list };
    },

    async addGroupParticipants({ groupId, participants }) {
      if (!groupId || typeof groupId !== 'string') {
        throwBadRequest('groupId is required and must be a string.');
      }
      if (!Array.isArray(participants) || participants.length === 0) {
        throwBadRequest('participants is required and must be a non-empty array of JIDs.');
      }
      await ensureConnected();

      const jids = participants.map((p) => String(p).trim());
      const result = await socket.groupParticipantsUpdate(groupId.trim(), jids, 'add');
      pushEvent('group.participants.add', { groupId, participants: jids });
      return { groupId, participants: jids, result };
    },

    async removeGroupParticipants({ groupId, participants }) {
      if (!groupId || typeof groupId !== 'string') {
        throwBadRequest('groupId is required and must be a string.');
      }
      if (!Array.isArray(participants) || participants.length === 0) {
        throwBadRequest('participants is required and must be a non-empty array of JIDs.');
      }
      await ensureConnected();

      const jids = participants.map((p) => String(p).trim());
      const result = await socket.groupParticipantsUpdate(groupId.trim(), jids, 'remove');
      pushEvent('group.participants.remove', { groupId, participants: jids });
      return { groupId, participants: jids, result };
    },

    async getContact({ target }) {
      const jid = normalizeTarget(target);
      await ensureConnected();

      const [result] = await socket.onWhatsApp(jid.replace(/@.*/, ''));
      if (!result?.exists) {
        const error = new Error('Contact not found on WhatsApp.');
        error.statusCode = 404;
        throw error;
      }
      return { jid: result.jid, exists: true };
    },

    async blockContact({ target }) {
      const jid = normalizeTarget(target);
      await ensureConnected();

      await socket.updateBlockStatus(jid, 'block');
      pushEvent('contact.block', { jid });
      return { jid, blocked: true };
    },

    async unblockContact({ target }) {
      const jid = normalizeTarget(target);
      await ensureConnected();

      await socket.updateBlockStatus(jid, 'unblock');
      pushEvent('contact.unblock', { jid });
      return { jid, blocked: false };
    },

    async deleteMessage({ target, messageId, fromMe, participant }) {
      const jid = normalizeTarget(target);
      if (!messageId || typeof messageId !== 'string') {
        throwBadRequest('messageId is required and must be a string.');
      }
      if (typeof fromMe !== 'boolean') {
        throwBadRequest('fromMe is required and must be a boolean.');
      }

      await ensureConnected();

      const key = { remoteJid: jid, fromMe, id: messageId };
      if (participant && typeof participant === 'string') {
        key.participant = participant.trim();
      }

      await socket.sendMessage(jid, { delete: key });
      pushEvent('message.delete', { jid, messageId, fromMe, participant: key.participant });
      return { jid, messageId, fromMe };
    },
  };
}

module.exports = {
  createWhatsAppService,
  parseDateInput,
  readEventsBetween,
};
