'use strict';

const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'baileys',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 50,
            connectTimeout: 10000,
            timezone: '+00:00',
        });
    }
    return pool;
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

async function pingDb() {
    const conn = await getPool().getConnection();
    try {
        await conn.ping();
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function withDeadlockRetry(fn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (error.code === 'ER_LOCK_DEADLOCK' && attempt < maxRetries) {
                const delay = Math.min(1000, 50 * (2 ** attempt));
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
}

// ---------------------------------------------------------------------------
// Number config
// ---------------------------------------------------------------------------

async function getNumberConfig(phoneNumber) {
    const [rows] = await getPool().query(
        'SELECT * FROM wa_numbers WHERE phone_number = ?',
        [phoneNumber]
    );
    return rows[0] || null;
}

async function upsertNumberConfig(phoneNumber, config = {}) {
    await getPool().query(
        `INSERT INTO wa_numbers
         (phone_number, webhook_url, webhook_timeout_ms, webhook_max_retries,
          webhook_retry_base_ms, webhook_retry_max_ms, event_retention,
          reconnect_base_ms, reconnect_max_ms, full_history_on_reconnect)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE webhook_url               = VALUES(webhook_url),
                                 webhook_timeout_ms        = VALUES(webhook_timeout_ms),
                                 webhook_max_retries       = VALUES(webhook_max_retries),
                                 webhook_retry_base_ms     = VALUES(webhook_retry_base_ms),
                                 webhook_retry_max_ms      = VALUES(webhook_retry_max_ms),
                                 event_retention           = VALUES(event_retention),
                                 reconnect_base_ms         = VALUES(reconnect_base_ms),
                                 reconnect_max_ms          = VALUES(reconnect_max_ms),
                                 full_history_on_reconnect = VALUES(full_history_on_reconnect)`,
        [
            phoneNumber,
            config.webhook_url ?? '',
            config.webhook_timeout_ms ?? 8000,
            config.webhook_max_retries ?? 8,
            config.webhook_retry_base_ms ?? 1000,
            config.webhook_retry_max_ms ?? 30000,
            config.event_retention ?? 2000,
            config.reconnect_base_ms ?? 1500,
            config.reconnect_max_ms ?? 30000,
            config.full_history_on_reconnect != null ? config.full_history_on_reconnect : 1,
        ]
    );
}

// ---------------------------------------------------------------------------
// Auth credentials  (stored as a raw BufferJSON string)
// ---------------------------------------------------------------------------

async function getAuthCredsData(phoneNumber) {
    const [rows] = await getPool().query(
        'SELECT creds_data FROM wa_auth_creds WHERE phone_number = ?',
        [phoneNumber]
    );
    return rows[0] ? rows[0].creds_data : null;
}

async function saveAuthCredsData(phoneNumber, credsStr) {
    await getPool().query(
        `INSERT INTO wa_auth_creds (phone_number, creds_data)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE creds_data = VALUES(creds_data),
                                 updated_at = CURRENT_TIMESTAMP`,
        [phoneNumber, credsStr]
    );
}

// ---------------------------------------------------------------------------
// Auth signal keys  (each key stored as a raw BufferJSON string)
// ---------------------------------------------------------------------------

async function getAuthKeysData(phoneNumber, keyType, keyIds) {
    if (!keyIds.length) return {};
    const placeholders = keyIds.map(() => '?').join(', ');
    const [rows] = await getPool().query(
        `SELECT key_id, key_data
         FROM wa_auth_keys
         WHERE phone_number = ?
           AND key_type = ?
           AND key_id IN (${placeholders})
           AND key_data IS NOT NULL`,
        [phoneNumber, keyType, ...keyIds]
    );
    const result = {};
    for (const row of rows) {
        result[row.key_id] = row.key_data;
    }
    return result;
}

async function setAuthKeysData(phoneNumber, entries) {
    // entries: Array<{ keyType, keyId, keyDataStr }>  — keyDataStr null means delete
    const toUpsert = entries.filter((e) => e.keyDataStr !== null);
    const toDelete = entries.filter((e) => e.keyDataStr === null);

    if (!toUpsert.length && !toDelete.length) return;

    return withDeadlockRetry(async () => {
        const conn = await getPool().getConnection();
        try {
            await conn.beginTransaction();

            if (toUpsert.length) {
                const values = toUpsert.map((e) => [phoneNumber, e.keyType, e.keyId, e.keyDataStr]);
                await conn.query(
                    `INSERT INTO wa_auth_keys (phone_number, key_type, key_id, key_data)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE key_data = VALUES(key_data),
                                             updated_at = CURRENT_TIMESTAMP`,
                    [values]
                );
            }

            for (const { keyType, keyId } of toDelete) {
                await conn.query(
                    'DELETE FROM wa_auth_keys WHERE phone_number = ? AND key_type = ? AND key_id = ?',
                    [phoneNumber, keyType, keyId]
                );
            }

            await conn.commit();
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    });
}

async function deleteAuthState(phoneNumber) {
    await Promise.all([
        getPool().query('DELETE FROM wa_auth_creds WHERE phone_number = ?', [phoneNumber]),
        getPool().query('DELETE FROM wa_auth_keys WHERE phone_number = ?', [phoneNumber]),
    ]);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function insertEvent(phoneNumber, event) {
    await getPool().query(
        `INSERT INTO wa_events (phone_number, event_timestamp, event_type, payload)
         VALUES (?, ?, ?, ?)`,
        [
            phoneNumber,
            new Date(event.timestamp),
            event.eventType,
            JSON.stringify(event.payload),
        ]
    );
}

async function queryEventsBetween(phoneNumber, startDate, endDate) {
    const [rows] = await getPool().query(
        `SELECT event_timestamp, event_type, payload
         FROM wa_events
         WHERE phone_number = ?
           AND event_timestamp >= ?
           AND event_timestamp <= ?
         ORDER BY event_timestamp ASC`,
        [phoneNumber, startDate, endDate]
    );

    return rows.map((row) => ({
        timestamp: row.event_timestamp instanceof Date
            ? row.event_timestamp.toISOString()
            : row.event_timestamp,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    }));
}

// ---------------------------------------------------------------------------
// Webhook targets
// ---------------------------------------------------------------------------

async function getWebhookTargets(phoneNumber) {
    const [rows] = await getPool().query(
        'SELECT id, url, created_at FROM wa_webhook_targets WHERE phone_number = ? ORDER BY id ASC',
        [phoneNumber]
    );
    return rows;
}

async function insertWebhookTarget(phoneNumber, url) {
    const [result] = await getPool().query(
        'INSERT INTO wa_webhook_targets (phone_number, url) VALUES (?, ?)',
        [phoneNumber, url]
    );
    return result.insertId;
}

async function deleteWebhookTarget(id, phoneNumber) {
    const [result] = await getPool().query(
        'DELETE FROM wa_webhook_targets WHERE id = ? AND phone_number = ?',
        [id, phoneNumber]
    );
    return result.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Webhook queue  (persisted so retries survive restarts)
// ---------------------------------------------------------------------------

async function loadPendingWebhookItems(phoneNumber) {
    const [rows] = await getPool().query(
        `SELECT id, webhook_url, payload, attempt, enqueued_at
         FROM wa_webhook_queue
         WHERE phone_number = ?
         ORDER BY enqueued_at ASC`,
        [phoneNumber]
    );
    return rows.map((row) => ({
        dbId: row.id,
        url: row.webhook_url,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        attempt: row.attempt,
        enqueuedAt: row.enqueued_at instanceof Date
            ? row.enqueued_at.toISOString()
            : row.enqueued_at,
    }));
}

async function insertWebhookQueueItem(phoneNumber, webhookUrl, payload, enqueuedAt) {
    const ts = new Date(enqueuedAt);
    const [result] = await getPool().query(
        `INSERT INTO wa_webhook_queue (phone_number, webhook_url, payload, attempt, enqueued_at, next_retry_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [phoneNumber, webhookUrl, JSON.stringify(payload), ts, ts]
    );
    return result.insertId;
}

async function updateWebhookQueueItem(id, attempt, nextRetryAt) {
    await getPool().query(
        'UPDATE wa_webhook_queue SET attempt = ?, next_retry_at = ? WHERE id = ?',
        [attempt, new Date(nextRetryAt), id]
    );
}

async function deleteWebhookQueueItem(id) {
    await getPool().query('DELETE FROM wa_webhook_queue WHERE id = ?', [id]);
}

module.exports = {
    getPool,
    closePool,
    pingDb,
    getNumberConfig,
    upsertNumberConfig,
    getAuthCredsData,
    saveAuthCredsData,
    getAuthKeysData,
    setAuthKeysData,
    deleteAuthState,
    insertEvent,
    queryEventsBetween,
    getWebhookTargets,
    insertWebhookTarget,
    deleteWebhookTarget,
    loadPendingWebhookItems,
    insertWebhookQueueItem,
    updateWebhookQueueItem,
    deleteWebhookQueueItem,
};
