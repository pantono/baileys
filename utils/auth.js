'use strict';

const {initAuthCreds, BufferJSON, proto} = require('@whiskeysockets/baileys');
const db = require('./db');

/**
 * MySQL-backed auth state for Baileys.
 * Drop-in replacement for useMultiFileAuthState — returns { state, saveCreds }.
 */
async function useMySQLAuthState(phoneNumber) {
    // Load or initialise credentials
    let creds;
    const credsStr = await db.getAuthCredsData(phoneNumber);
    if (credsStr) {
        creds = JSON.parse(credsStr, BufferJSON.reviver);
    } else {
        creds = initAuthCreds();
    }

    const state = {
        creds,
        keys: {
            /**
             * Read keys by type + ids, restoring Buffer values and proto objects.
             * Matches the multi-file impl: returns {} (not null) for missing ids.
             */
            get: async (type, ids) => {
                const rawMap = await db.getAuthKeysData(phoneNumber, type, ids);
                const result = {};
                for (const id of ids) {
                    if (!rawMap[id]) continue;
                    let value = JSON.parse(rawMap[id], BufferJSON.reviver);
                    // Baileys expects the app-state-sync key as a proto object, same as
                    // the multi-file implementation does after reading from disk.
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    result[id] = value;
                }
                return result;
            },

            /**
             * Write (or delete when value is null/undefined) keys by type.
             */
            set: async (data) => {
                const entries = [];
                for (const [keyType, keys] of Object.entries(data)) {
                    for (const [keyId, value] of Object.entries(keys)) {
                        const keyDataStr = value != null
                            ? JSON.stringify(value, BufferJSON.replacer)
                            : null;
                        entries.push({keyType, keyId, keyDataStr});
                    }
                }
                if (entries.length) {
                    await db.setAuthKeysData(phoneNumber, entries);
                }
            },
        },
    };

    async function saveCreds() {
        await db.saveAuthCredsData(
            phoneNumber,
            JSON.stringify(creds, BufferJSON.replacer)
        );
    }

    return {state, saveCreds};
}

module.exports = {useMySQLAuthState};
