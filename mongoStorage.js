const dns = require('dns');
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

let mongoClient = null;
let dbInstance = null;

/**
 * Connect to MongoDB Atlas or self-hosted MongoDB
 */
async function getMongoDb() {
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;

    if (!mongoClient) {
        mongoClient = new MongoClient(uri, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 8000,
            connectTimeoutMS: 10000
        });
        await mongoClient.connect();
        dbInstance = mongoClient.db(process.env.MONGODB_DB_NAME || 'whatsapp_ai');
    }
    return dbInstance;
}

/**
 * Baileys Auth State using MongoDB
 * Ensures credentials and rotating prekeys survive ephemeral container wipes on Render
 */
async function useMongoAuthState(collectionName = 'auth_sessions', localFallbackDir = null) {
    const db = await getMongoDb();
    if (!db) {
        throw new Error('MongoDB URI not configured');
    }

    const collection = db.collection(collectionName);
    const memoryCache = new Map();

    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

    // Helper: Read single key/doc
    const readData = async (file) => {
        const cleanFile = fixFileName(file);
        if (memoryCache.has(cleanFile)) {
            return memoryCache.get(cleanFile);
        }

        try {
            const doc = await collection.findOne({ _id: cleanFile });
            if (!doc || !doc.data) return null;
            const parsed = JSON.parse(doc.data, BufferJSON.reviver);
            memoryCache.set(cleanFile, parsed);
            return parsed;
        } catch (err) {
            return null;
        }
    };

    // Helper: Write single key/doc
    const writeData = async (data, file) => {
        const cleanFile = fixFileName(file);
        memoryCache.set(cleanFile, data);
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer);
            await collection.updateOne(
                { _id: cleanFile },
                { $set: { data: serialized, updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            console.error(`[MONGODB] Failed to write key ${cleanFile}:`, err.message);
        }
    };

    // Helper: Remove key/doc
    const removeData = async (file) => {
        const cleanFile = fixFileName(file);
        memoryCache.delete(cleanFile);
        try {
            await collection.deleteOne({ _id: cleanFile });
        } catch (err) {
            console.error(`[MONGODB] Failed to remove key ${cleanFile}:`, err.message);
        }
    };

    // Auto-migrate from local folder if MongoDB is completely empty
    if (localFallbackDir && fs.existsSync(localFallbackDir)) {
        try {
            const count = await collection.countDocuments();
            const credsFile = path.join(localFallbackDir, 'creds.json');
            if (count === 0 && fs.existsSync(credsFile)) {
                console.log('[MONGODB] First-time setup detected: Migrating local WhatsApp auth files to MongoDB Atlas...');
                const files = fs.readdirSync(localFallbackDir);
                let migratedCount = 0;
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const filePath = path.join(localFallbackDir, file);
                        const raw = fs.readFileSync(filePath, 'utf-8');
                        await collection.updateOne(
                            { _id: fixFileName(file) },
                            { $set: { data: raw, updatedAt: new Date() } },
                            { upsert: true }
                        );
                        migratedCount++;
                    }
                }
                console.log(`[MONGODB] Successfully migrated ${migratedCount} auth files to MongoDB! WhatsApp session is now cloud-persisted.`);
            }
        } catch (migErr) {
            console.error('[MONGODB] Migration warning:', migErr.message);
        }
    }

    const creds = (await readData('creds.json')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
}

/**
 * Synchronize Application Config with MongoDB
 */
async function loadMongoConfig(defaultConfig) {
    const db = await getMongoDb();
    if (!db) return null;

    try {
        const collection = db.collection('app_config');
        const doc = await collection.findOne({ _id: 'main_config' });
        if (doc && doc.config) {
            return doc.config;
        } else if (defaultConfig) {
            // First time seeding
            await collection.updateOne(
                { _id: 'main_config' },
                { $set: { config: defaultConfig, updatedAt: new Date() } },
                { upsert: true }
            );
        }
    } catch (err) {
        console.error('[MONGODB] Config read warning:', err.message);
    }
    return null;
}

async function saveMongoConfig(config) {
    const db = await getMongoDb();
    if (!db) return;

    try {
        const collection = db.collection('app_config');
        await collection.updateOne(
            { _id: 'main_config' },
            { $set: { config, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error('[MONGODB] Config save warning:', err.message);
    }
}

module.exports = {
    getMongoDb,
    useMongoAuthState,
    loadMongoConfig,
    saveMongoConfig
};
