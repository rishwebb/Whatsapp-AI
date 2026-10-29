/**
 * Cloud Sync Engine for AI WhatsApp Bridge
 * 
 * Solves the Baileys Ephemeral Disk & Constant Logout Bug:
 * 1. Startup: Restores session keys and config from MongoDB Atlas to local disk BEFORE Baileys starts.
 * 2. Runtime: Baileys runs 100% on native local disk (useMultiFileAuthState). ZERO latency, ZERO Signal race conditions, ZERO Bad MAC drops!
 * 3. Background: Debounced, non-blocking sync of auth credentials to MongoDB Atlas.
 * 4. Fallback: If MONGODB_URI is absent, works offline seamlessly on local filesystem.
 */

const dns = require('dns');
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let isConnected = false;
let authDir = '';
let configFile = '';
let authSyncTimeout = null;

async function initCloudSync(paths = {}) {
    authDir = paths.authDir;
    configFile = paths.configFile;

    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.log('[CLOUD SYNC] MONGODB_URI not set. Running in local filesystem mode.');
        return { enabled: false, connected: false };
    }

    try {
        console.log('[CLOUD SYNC] Connecting to MongoDB Atlas for persistent cloud auth...');
        client = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 8000,
            connectTimeoutMS: 10000
        });
        await client.connect();
        db = client.db(process.env.MONGODB_DB_NAME || process.env.DB_NAME || 'whatsapp_ai');
        isConnected = true;
        console.log(`[CLOUD SYNC] Connected to MongoDB Atlas (${db.databaseName}) successfully! 🛡️`);
        return { enabled: true, connected: true };
    } catch (err) {
        console.error('[CLOUD SYNC ERROR] Failed to connect to MongoDB Atlas:', err.message);
        console.log('[CLOUD SYNC] Falling back to local filesystem storage.');
        isConnected = false;
        return { enabled: true, connected: false, error: err.message };
    }
}

/**
 * Restore credentials and config from MongoDB Atlas
 * Runs BEFORE Baileys starts so that existing login is restored instantly without scanning QR.
 */
async function restoreFromCloud() {
    if (!isConnected || !db) return { restored: false, reason: 'Not connected' };

    let restoredAuthCount = 0;

    try {
        // 1. Restore Auth State (Baileys Session)
        const credsFile = path.join(authDir, 'creds.json');
        const localCredsExist = fs.existsSync(credsFile);

        const authCollection = db.collection('auth_sessions');
        const authDocs = await authCollection.find({}).toArray();

        if (!localCredsExist && authDocs.length > 0) {
            console.log(`[CLOUD RESTORE] Local auth folder is empty. Restoring ${authDocs.length} session files from MongoDB...`);
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

            for (const doc of authDocs) {
                // Ensure safe direct filename without corrupting hyphens or colons
                const safeName = path.basename(doc._id);
                const targetFilePath = path.join(authDir, safeName);
                try {
                    const content = doc.content || doc.data || (typeof doc === 'string' ? doc : JSON.stringify(doc));
                    fs.writeFileSync(targetFilePath, content, 'utf8');
                    restoredAuthCount++;
                } catch (e) {
                    console.error(`[CLOUD RESTORE ERROR] Writing ${safeName}:`, e.message);
                }
            }
            console.log(`[CLOUD RESTORE] Successfully restored ${restoredAuthCount} session files! WhatsApp session is restored. 🎉`);
        } else if (localCredsExist) {
            console.log('[CLOUD RESTORE] Local creds.json already exists. Using active local session.');
        }

        // 2. Restore Configuration
        const configCollection = db.collection('app_config');
        const configDoc = await configCollection.findOne({ _id: 'main_config' });
        if (configDoc && configDoc.config) {
            try {
                fs.writeFileSync(configFile, JSON.stringify(configDoc.config, null, 2), 'utf8');
                console.log('[CLOUD RESTORE] Synchronized configuration from MongoDB Atlas.');
            } catch (_) {}
        }

        return { restored: true, count: restoredAuthCount };
    } catch (err) {
        console.error('[CLOUD RESTORE ERROR]', err.message);
        return { restored: false, error: err.message };
    }
}

/**
 * Debounced, background sync of local auth files to MongoDB Atlas.
 * Zero lag on Baileys socket!
 */
function queueAuthSync(delayMs = 1500) {
    if (!isConnected || !db || !authDir) return;

    if (authSyncTimeout) clearTimeout(authSyncTimeout);
    authSyncTimeout = setTimeout(async () => {
        authSyncTimeout = null;
        try {
            if (!fs.existsSync(authDir)) return;
            const files = fs.readdirSync(authDir);
            const authCollection = db.collection('auth_sessions');

            let synced = 0;
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const filePath = path.join(authDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    await authCollection.updateOne(
                        { _id: file },
                        { $set: { _id: file, data: content, content, updatedAt: new Date() } },
                        { upsert: true }
                    );
                    synced++;
                } catch (_) {}
            }
            if (synced > 0) {
                // Keep console clean, only log significant syncs
            }
        } catch (err) {
            console.error('[CLOUD AUTH SYNC ERROR]', err.message);
        }
    }, delayMs);
}

/**
 * Sync configuration to MongoDB Atlas
 */
async function syncSettingsToCloud(configObj) {
    if (!isConnected || !db) return;
    try {
        const configCollection = db.collection('app_config');
        await configCollection.updateOne(
            { _id: 'main_config' },
            { $set: { config: configObj, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error('[CLOUD CONFIG SYNC ERROR]', err.message);
    }
}

/**
 * Clear cloud session on manual unpair / logout
 */
async function clearCloudAuth() {
    if (!isConnected || !db) return;
    try {
        const authCollection = db.collection('auth_sessions');
        await authCollection.deleteMany({});
        console.log('[CLOUD SYNC] Purged auth_sessions from MongoDB Atlas.');
    } catch (err) {
        console.error('[CLOUD SYNC] Error clearing cloud auth:', err.message);
    }
}

function getCloudStatus() {
    return {
        configured: Boolean(process.env.MONGODB_URI),
        connected: isConnected,
        database: db ? db.databaseName : null
    };
}

module.exports = {
    initCloudSync,
    restoreFromCloud,
    queueAuthSync,
    syncSettingsToCloud,
    clearCloudAuth,
    getCloudStatus
};
