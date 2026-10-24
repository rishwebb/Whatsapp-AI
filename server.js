require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const Groq = require('groq-sdk');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const util = require('util');
const {
    useMongoAuthState,
    clearMongoAuth,
    loadMongoConfig,
    saveMongoConfig
} = require('./mongoStorage');

// -------------------------------------------------------------
// Production Logger & Libsignal Console Noise Filter
// -------------------------------------------------------------
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const SUPPRESSED_PATTERNS = [
    'Session error',
    'SessionEntry',
    'Bad MAC Error',
    'Bad MAC',
    'MessageCounterError',
    'Failed to decrypt message',
    'Decrypted message with closed session',
    'Key used already or never filled',
    'Closing session',
    'Removing old closed session'
];

function shouldSuppress(args) {
    if (!args || args.length === 0) return false;
    const combined = args.map(a => {
        if (!a) return '';
        if (typeof a === 'string') return a;
        if (a.stack) return a.stack;
        if (a.message) return a.message;
        try {
            return util.inspect(a, { depth: 1, maxArrayLength: 5 });
        } catch {
            return String(a);
        }
    }).join(' ');
    return SUPPRESSED_PATTERNS.some(pat => combined.includes(pat));
}

console.log = (...args) => {
    if (shouldSuppress(args)) return;
    originalConsoleLog(...args);
};

console.error = (...args) => {
    if (shouldSuppress(args)) return;
    originalConsoleError(...args);
};

const app = express();
const PORT = process.env.PORT || 4000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 🛡️ Health Check & Keep-Alive Endpoints (Critical for Render uptime monitors)
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime(), state: connectionStatus }));
app.get('/ping', (req, res) => res.status(200).send('pong'));

// -------------------------------------------------------------
// Groq Multi-Key & Multi-Tier Model Configuration
// -------------------------------------------------------------
const DEFAULT_GROQ_KEYS = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5
].filter(Boolean);

// Smaller, high-speed, high-limit model tiers on Groq
const MODEL_TIERS = [
    'qwen/qwen3.8-27b',     // Tier 1: 27B parameters, 1,000 RPM, instant generation, expert in Banglish / Hinglish / English
    'openai/gpt-oss-20b',   // Tier 2: 20B parameters, lightweight, 1,000 RPM, high token efficiency
    'openai/gpt-oss-120b'   // Tier 3: 120B parameters, high intelligence fallback
];

const DEFAULT_SYSTEM_PROMPT = `You are Rishav's AI assistant chatting on WhatsApp. Always refer to Rishav as 'Master' if you ever need to mention him.
You are chatting with Master's friends and contacts.

ROLE & PERSONALITY:
- You are a friendly, witty, smart, and cheerful AI companion.
- You are an AI (Rishav's AI), so do not pretend to be Rishav himself, but enjoy chatting, joking, listening, and keeping people company.
- Default to CASUAL, ENGAGING CHAT for normal conversations. React to what they say, joke around, ask how they are, and reply warmly!

RULE #1: STRICT LANGUAGE MATCHING (MANDATORY):
- Detect and reply in the EXACT language of the user's latest message:
  * If the user speaks ENGLISH -> Reply ONLY in pure, natural ENGLISH! Never reply in Bengali, Banglish, or Hindi.
  * If the user speaks BANGLISH (Bengali written in English letters, e.g. "kmn achis", "ki korcho", "taka de") -> Reply in BANGLISH.
  * If the user speaks HINGLISH (Hindi written in English letters, e.g. "kaise ho", "kya kar raha hai", "paise de") -> Reply in HINGLISH.
  * If the user writes in BENGALI SCRIPT (বাংলা) -> Reply in বাংলা.
  * If the user writes in HINDI SCRIPT (हिंदी) -> Reply in हिंदी.

CASUAL CHATTING RULES:
- For greetings, how-are-yous, casual questions, jokes, compliments, daily talk, or small talk:
  * Chat completely normally, casually, and warmly!
  * DO NOT say "Master is offline", DO NOT say "wait for Master to decide", and DO NOT push them away!
  * Example for "How are you bro?" (English): "I'm doing great! How are you doing? What are you up to today? 😊"
  * Example for "Kmn achis bhai" (Banglish): "Ami ekdom bhalo achi bhai! Tumi kemon acho? Ki korcho bolo? 😊"
  * Example for "Ki" (Banglish): "Kichu na, bolo ki khobor? Sob thikthak? 😊"
  * Example for "Kaisa hai bhai" (Hinglish): "Main badhiya hoon bhai! Tu kaisa hai? Kya chal raha hai? 😊"

STRICT DECISION & MONEY GUARDRAIL (ONLY for high-stakes/dire requests):
- ONLY when someone explicitly asks for money, UPI/bank transfers, financial transactions, signing contracts, or official commitments:
  * Politely refuse and say that as an AI you cannot handle money or official decisions, so let Master come and he will handle it.
  * MUST match the language of their request:
    - English: "I'm just Master's AI, so I can't handle money or financial transactions! Let Master come back and he'll sort this out. 😊"
    - Banglish: "Ami toh Master-er AI, tai taka-poysha ba boro kono decision ami nite parbo na. Master ashuk, oita o-i dekhbe! 😊"
    - Hinglish: "Main toh bas Master ka AI hoon, toh paise ya koi financial faisla main nahi le sakta. Master aayenge tab wahi decide karenge! 😊"

MEDIA & ATTACHMENT RULES (Images, Audios, Videos, Files):
- You CANNOT see images/photos/videos or hear audio messages.
- If the sender asks about an image, video, audio, or file they sent, always respond politely in English:
  * Images: "I can't view images, let's wait for Rishav to come back online! 👀📸"
  * Audios: "I cannot hear audios, let's wait for Rishav to come back online! 🎧🔇"
  * Videos: "I cannot view videos, let's wait for Rishav to come back online! 🎬🍿"

FORMAT:
- Always use natural emojis (😊, 😂, ✨, 👍, 🙌, etc.).
- Keep responses short, natural, and punchy (1-2 sentences), ideal for WhatsApp.`;

function loadConfig() {
    const defaultConfig = {
        masterEnabled: true,
        groqApiKey: DEFAULT_GROQ_KEYS[0] || '',
        groqKeys: DEFAULT_GROQ_KEYS,
        model: 'qwen/qwen3.8-27b',
        temperature: 0.65,
        maxTokens: 180,
        defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        whitelistMode: 'only_whitelisted',
        allowGroups: false,
        contacts: {}
    };

    if (!fs.existsSync(CONFIG_FILE)) {
        if (fs.existsSync(`${CONFIG_FILE}.bak`)) {
            try {
                fs.copyFileSync(`${CONFIG_FILE}.bak`, CONFIG_FILE);
            } catch (_) {}
        } else {
            try {
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
            } catch (_) {}
            return defaultConfig;
        }
    }

    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.groqKeys || parsed.groqKeys.length === 0) {
            parsed.groqKeys = DEFAULT_GROQ_KEYS;
        }
        return { ...defaultConfig, ...parsed };
    } catch (e) {
        console.error('Error reading config.json, attempting backup recovery:', e.message);
        if (fs.existsSync(`${CONFIG_FILE}.bak`)) {
            try {
                const bak = JSON.parse(fs.readFileSync(`${CONFIG_FILE}.bak`, 'utf8'));
                return { ...defaultConfig, ...bak };
            } catch (_) {}
        }
        return defaultConfig;
    }
}

let config = loadConfig();

// Atomic & Resilient Config Saving
function saveConfig() {
    try {
        const tempPath = `${CONFIG_FILE}.tmp`;
        const bakPath = `${CONFIG_FILE}.bak`;
        const data = JSON.stringify(config, null, 2);
        fs.writeFileSync(tempPath, data, 'utf8');
        try { fs.copyFileSync(tempPath, bakPath); } catch (_) {}
        fs.renameSync(tempPath, CONFIG_FILE);
    } catch (e) {
        console.error('Failed to save config.json:', e.message);
    }
    if (process.env.MONGODB_URI) {
        saveMongoConfig(config).catch(err => console.error('[MONGODB] Save config error:', err.message));
    }
}

// -------------------------------------------------------------
// Groq Multi-Key Pool & Load Balancer with Circuit Breaker
// -------------------------------------------------------------
let currentKeyIndex = 0;
const keyStatsMap = new Map();
const keyCooldowns = new Map(); // key -> timestamp when cooldown expires

function getActiveKeyPool() {
    let pool = Array.isArray(config.groqKeys) && config.groqKeys.length > 0
        ? config.groqKeys.filter(k => typeof k === 'string' && k.trim().length > 10)
        : [];
    if (pool.length === 0 && config.groqApiKey) {
        pool = [config.groqApiKey];
    }
    if (pool.length === 0) {
        pool = DEFAULT_GROQ_KEYS;
    }
    return pool;
}

function isKeyCoolingDown(key) {
    const until = keyCooldowns.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
        keyCooldowns.delete(key);
        return false;
    }
    return true;
}

function getKeyCooldownRemaining(key) {
    const until = keyCooldowns.get(key);
    if (!until) return 0;
    const remaining = Math.ceil((until - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
}

function getKeyStats() {
    const pool = getActiveKeyPool();
    return pool.map((key, idx) => {
        const stats = keyStatsMap.get(key) || { calls: 0, errors: 0, lastUsed: null };
        const cooling = isKeyCoolingDown(key);
        return {
            index: idx + 1,
            masked: `${key.slice(0, 8)}...${key.slice(-4)}`,
            calls: stats.calls,
            errors: stats.errors,
            lastUsed: stats.lastUsed,
            isCoolingDown: cooling,
            cooldownSeconds: cooling ? getKeyCooldownRemaining(key) : 0
        };
    });
}

async function executeGroqWithPool(messages, preferredModel, temperature, maxTokens) {
    const pool = getActiveKeyPool();
    if (pool.length === 0) {
        throw new Error('No Groq API keys available in the pool');
    }

    // Build model list to try, starting with preferredModel
    const modelsToTry = [preferredModel || config.model || 'qwen/qwen3.8-27b'];
    for (const m of MODEL_TIERS) {
        if (!modelsToTry.includes(m)) modelsToTry.push(m);
    }

    let lastError = null;

    // Outer loop: Try models in order of tiers
    for (const currentModel of modelsToTry) {
        const startIndex = currentKeyIndex;

        // Inner loop: Try each key in the pool for this model
        for (let attempt = 0; attempt < pool.length; attempt++) {
            const keyIdx = (startIndex + attempt) % pool.length;
            const apiKey = pool[keyIdx];
            const masked = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;

            // Skip keys in rate-limit cooldown unless all keys are cooling down
            if (isKeyCoolingDown(apiKey) && pool.some(k => !isKeyCoolingDown(k))) {
                continue;
            }

            try {
                const groq = new Groq({ apiKey });
                const completion = await groq.chat.completions.create({
                    messages,
                    model: currentModel,
                    temperature: typeof temperature === 'number' ? temperature : 0.65,
                    max_tokens: maxTokens || 180
                });

                const reply = completion.choices[0]?.message?.content?.trim();
                if (!reply || reply.length < 2) {
                    throw new Error(`Empty content returned by ${currentModel}`);
                }

                // Update key stats
                const s = keyStatsMap.get(apiKey) || { calls: 0, errors: 0, lastUsed: null };
                s.calls++;
                s.lastUsed = Date.now();
                keyStatsMap.set(apiKey, s);

                // Success clears any lingering cooldown
                keyCooldowns.delete(apiKey);

                // Rotate to next key for true round-robin load distribution
                currentKeyIndex = (keyIdx + 1) % pool.length;
                return { reply, keyUsed: masked, keyIndex: keyIdx + 1, modelUsed: currentModel };
            } catch (err) {
                const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
                const s = keyStatsMap.get(apiKey) || { calls: 0, errors: 0, lastUsed: null };
                s.errors++;
                keyStatsMap.set(apiKey, s);

                lastError = err;
                currentKeyIndex = (keyIdx + 1) % pool.length;

                if (isRateLimit) {
                    keyCooldowns.set(apiKey, Date.now() + 30000); // 30s cooldown
                    log('WARN', `[Groq Pool] Key #${keyIdx + 1} (${masked}) hit 429 rate limit on ${currentModel}. Cooling down for 30s...`);
                }
            }
        }

        log('WARN', `[Groq Pool] All available keys exhausted for ${currentModel}. Falling back to next model tier...`);
    }

    throw lastError || new Error('All Groq API keys and model tiers failed to generate a response');
}

// -------------------------------------------------------------
// Logging & Statistics
// -------------------------------------------------------------
let recentLogs = [];
const stats = {
    startedAt: Date.now(),
    messagesReceived: 0,
    repliesSent: 0,
    messagesIgnored: 0
};

function log(type, message) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
    const logItem = {
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        time: timestamp,
        type: type.toUpperCase(),
        message
    };
    originalConsoleLog(`[${logItem.time}] [${logItem.type}] ${message}`);
    recentLogs.unshift(logItem);
    if (recentLogs.length > 100) recentLogs.pop();
}

// -------------------------------------------------------------
// Conversation History Cache (Context memory per contact)
// -------------------------------------------------------------
const conversationHistory = new Map(); // jid -> [{ role: 'user'|'assistant', content }]

function getHistory(jid) {
    if (!conversationHistory.has(jid)) {
        conversationHistory.set(jid, []);
    }
    return conversationHistory.get(jid);
}

function addToHistory(jid, role, content) {
    const hist = getHistory(jid);
    hist.push({ role, content });
    // Keep max 4 turns (2 user, 2 assistant) to save tokens and prevent rate limit exhaustion
    if (hist.length > 4) hist.shift();
}

// Periodic memory sweep: Prune inactive contacts (> 24 hours) to avoid memory leaks
setInterval(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [jid] of conversationHistory.entries()) {
        const contact = config.contacts[jid];
        if (!contact || !contact.lastActive || contact.lastActive < oneDayAgo) {
            conversationHistory.delete(jid);
            pruned++;
        }
    }
    if (pruned > 0) {
        log('INFO', `[Memory Sweep] Pruned ${pruned} stale contact conversation contexts.`);
    }
}, 60 * 60 * 1000);

// 🛡️ Periodic Stealth Check: Guarantee 24/7 Offline status when idle
setInterval(async () => {
    if (sock && connectionStatus === 'CONNECTED') {
        try {
            await sock.sendPresenceUpdate('unavailable').catch(() => {});
        } catch (_) {}
    }
}, 5 * 60 * 1000);

// Pure Emoji Matcher / Fallback
const PURE_EMOJI_REGEX = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+$/u;

function getEmojiFallback(text) {
    if (!text) return null;
    if (/[\u{1F600}-\u{1F606}\u{1F923}\u{1F602}]/u.test(text)) return '😂🙌 Haha!';
    if (/[\u{2764}\u{1F90D}\u{1F90E}\u{1F90F}\u{1F60D}\u{1F970}\u{1F618}]/u.test(text)) return '❤️✨';
    if (/[\u{1F622}\u{1F62D}\u{1F97A}\u{1F614}]/u.test(text)) return '🥺🫂 Sub thik toh?';
    if (/[\u{1F525}\u{1F60E}\u{1F44D}\u{1F44C}\u{1F4AF}]/u.test(text)) return '🔥👌 Badhiya!';
    if (/[\u{1F9D0}\u{1F914}]/u.test(text)) return '🧐 What are you thinking?';
    if (/[\u{1FAE3}]/u.test(text)) return '🫣 What are you hiding?';
    return '👋😊';
}

// -------------------------------------------------------------
// WhatsApp Baileys Engine
// -------------------------------------------------------------
let sock = null;
let connectionStatus = 'DISCONNECTED';
let currentQR = null;
let currentPairingCode = null;
let connectedUser = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let presenceTimer = null;
const MAX_RECONNECT_DELAY = 30000;

function cleanupCurrentSocket() {
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            if (sock.ws) {
                try {
                    sock.ws.removeAllListeners();
                    sock.ws.close();
                } catch (_) {}
            }
            sock.end(undefined);
        } catch (_) {}
        sock = null;
    }
}

async function setOffline() {
    if (!sock || connectionStatus !== 'CONNECTED') return;
    try {
        await sock.sendPresenceUpdate('unavailable').catch(() => {});
    } catch (_) {}
}

function scheduleReconnect(customDelay = null) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    const delay = customDelay || (Math.min(2000 * Math.pow(2, Math.min(reconnectAttempts - 1, 4)), MAX_RECONNECT_DELAY) + Math.floor(Math.random() * 1000));
    log('INFO', `Reconnecting WhatsApp in ${(delay / 1000).toFixed(1)}s (Attempt #${reconnectAttempts})...`);
    reconnectTimer = setTimeout(startWhatsApp, delay);
}

async function startWhatsApp() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Always cleanly tear down any existing socket before initializing a new one
    cleanupCurrentSocket();

    connectionStatus = 'CONNECTING';
    currentQR = null;
    currentPairingCode = null;
    log('INFO', 'Initializing WhatsApp socket...');

    try {
        let authState;
        if (process.env.MONGODB_URI) {
            log('INFO', 'MongoDB URI detected. Using MongoDB Atlas for persistent cloud auth...');
            authState = await useMongoAuthState('auth_sessions', AUTH_DIR);
            const cloudCfg = await loadMongoConfig(config).catch(() => null);
            if (cloudCfg) {
                config = { ...config, ...cloudCfg };
                log('INFO', 'Synchronized configuration from MongoDB Atlas.');
            }
        } else {
            if (!fs.existsSync(AUTH_DIR)) {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }
            authState = await useMultiFileAuthState(AUTH_DIR);
        }
        const { state, saveCreds } = authState;

        const { version, isLatest } = await fetchLatestBaileysVersion();
        log('INFO', `Using Baileys version ${version.join('.')} (Latest: ${isLatest})`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            markOnlineOnConnect: false, // 🛡️ Prevent WhatsApp Web from marking you 'Online' 24/7
            browser: Browsers.ubuntu('Chrome'),
            generateHighQualityLinkPreview: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'QR_READY';
                try {
                    currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
                    log('INFO', 'New QR Code generated. Scan with WhatsApp from the dashboard!');
                } catch (err) {
                    log('ERROR', `Failed to render QR Code: ${err.message}`);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                connectionStatus = 'DISCONNECTED';
                currentQR = null;
                currentPairingCode = null;
                connectedUser = null;

                log('ERROR', `Connection closed (Code: ${statusCode || 'Unknown'}).`);

                // Immediately destroy the dead/closing socket
                cleanupCurrentSocket();

                if (statusCode === DisconnectReason.loggedOut) {
                    reconnectAttempts = 0;
                    log('ERROR', 'Session logged out from phone. Cleaning auth credentials and generating fresh QR...');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {
                        console.error('Error cleaning auth folder:', e.message);
                    }
                    if (process.env.MONGODB_URI) {
                        await clearMongoAuth('auth_sessions').catch(() => {});
                    }
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(startWhatsApp, 2500);
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    reconnectAttempts = 0;
                    log('WARNING', 'Connection conflict (Code 440): another active connection was detected with this session. Waiting 25s for previous socket to release before reconnecting...');
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(startWhatsApp, 25000);
                } else {
                    scheduleReconnect();
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                reconnectAttempts = 0;
                currentQR = null;
                currentPairingCode = null;
                connectedUser = sock.user;
                const phone = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
                log('SUCCESS', `WhatsApp connected successfully! Linked Account: +${phone} (${sock.user?.name || 'User'})`);

                // 🛡️ Stealth Presence: markOnlineOnConnect is already false.
                // Settle socket handshake before sending unavailable presence update.
                setTimeout(async () => {
                    if (sock && connectionStatus === 'CONNECTED') {
                        try {
                            await sock.sendPresenceUpdate('unavailable');
                            log('INFO', 'Stealth Presence: Status set to OFFLINE (unavailable). 24/7 Online status disabled!');
                        } catch (_) {}
                    }
                }, 3500);
            }
        });

        // Incoming Messages Upsert Listener (Individual message processing)
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                handleIncomingMessage(msg);
            }
        });

    } catch (err) {
        log('ERROR', `Failed to start WhatsApp: ${err.message}`);
        connectionStatus = 'DISCONNECTED';
        scheduleReconnect();
    }
}

// -------------------------------------------------------------
// Message Sequential Queue & Dispatcher (Zero Skipping)
// -------------------------------------------------------------
const messageQueues = new Map(); // remoteJid -> Promise chain

function handleIncomingMessage(msg) {
    if (!msg || !msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;

    const isGroup = remoteJid.endsWith('@g.us');
    if (isGroup && !config.allowGroups) return;

    // Extract text and media types gracefully (unwrapping view-once, ephemeral, and document containers)
    const rawMsg = msg.message;
    const messageContent = rawMsg?.ephemeralMessage?.message ||
                           rawMsg?.viewOnceMessage?.message ||
                           rawMsg?.viewOnceMessageV2?.message ||
                           rawMsg?.documentWithCaptionMessage?.message ||
                           rawMsg || {};

    const caption = messageContent.imageMessage?.caption ||
                    messageContent.videoMessage?.caption ||
                    messageContent.documentMessage?.caption ||
                    '';

    let body = messageContent.conversation ||
               messageContent.extendedTextMessage?.text ||
               caption ||
               messageContent.buttonsResponseMessage?.selectedDisplayText ||
               messageContent.templateButtonReplyMessage?.selectedId ||
               '';

    const isAudio = !!(messageContent.audioMessage);
    const isSticker = !!(messageContent.stickerMessage);
    const isImage = !!(messageContent.imageMessage);
    const isVideo = !!(messageContent.videoMessage);
    const isDocument = !!(messageContent.documentMessage);

    if (isAudio) {
        body = "[Voice Note / Audio Message]";
    } else if (isSticker) {
        body = "[Sticker]";
    } else if (isImage) {
        body = caption.trim() ? `[Photo / Image with caption: ${caption.trim()}]` : "[Photo / Image]";
    } else if (isVideo) {
        body = caption.trim() ? `[Video with caption: ${caption.trim()}]` : "[Video]";
    } else if (isDocument) {
        body = caption.trim() ? `[Document / File with caption: ${caption.trim()}]` : "[Document / File]";
    }

    if (!body || !body.trim()) return;

    stats.messagesReceived++;

    const cleanPhone = remoteJid.split('@')[0];
    const pushName = msg.pushName || cleanPhone;

    // Auto-discover contact
    if (!config.contacts[remoteJid]) {
        config.contacts[remoteJid] = {
            name: pushName,
            phone: cleanPhone,
            enabled: false,
            customPrompt: '',
            lastGreetingDate: null,
            lastActive: Date.now(),
            lastMessage: body.slice(0, 80)
        };
        saveConfig();
        log('INFO', `Discovered new contact: ${pushName} (+${cleanPhone}). Whitelist status: DISABLED.`);
    } else {
        config.contacts[remoteJid].lastActive = Date.now();
        config.contacts[remoteJid].lastMessage = body.slice(0, 80);
        if (msg.pushName && !config.contacts[remoteJid].name) {
            config.contacts[remoteJid].name = msg.pushName;
        }
        saveConfig();
    }

    const contactConfig = config.contacts[remoteJid];

    // Check Master Switch
    if (!config.masterEnabled) {
        stats.messagesIgnored++;
        log('FILTER', `Master Switch is OFF. Ignored message from ${pushName}: "${body.slice(0, 30)}..."`);
        return;
    }

    // Check Whitelist Mode
    const isWhitelisted = contactConfig && contactConfig.enabled === true;
    if (config.whitelistMode === 'only_whitelisted' && !isWhitelisted) {
        stats.messagesIgnored++;
        log('FILTER', `Ignored non-whitelisted sender: ${pushName} (+${cleanPhone})`);
        return;
    }
    if (config.whitelistMode === 'all_except_disabled' && contactConfig && contactConfig.enabled === false) {
        stats.messagesIgnored++;
        log('FILTER', `Ignored disabled contact: ${pushName} (+${cleanPhone})`);
        return;
    }

    // Process every single message sequentially in queue without dropping or batching
    const currentQueue = messageQueues.get(remoteJid) || Promise.resolve();
    const nextQueue = currentQueue
        .then(() => processSingleMessage(msg, body.trim(), pushName, cleanPhone, contactConfig))
        .catch((err) => {
            log('ERROR', `Error processing message from ${pushName}: ${err.message}`);
        });

    messageQueues.set(remoteJid, nextQueue);
}

// -------------------------------------------------------------
// Language Detection & Direct Defense Guardrails
// -------------------------------------------------------------
function detectMessageLanguage(text) {
    if (!text) return 'English';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u0900-\u097F]/.test(text)) return 'Hindi';

    const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = new Set(lower.split(/\s+/).filter(Boolean));

    const banglishWords = [
        'ami', 'tumi', 'tui', 'apni', 'kemon', 'kmn', 'acho', 'achis', 'achen',
        'bolo', 'bolun', 'ki', 'korcho', 'korchis', 'korchen', 'khobor', 'bhalo',
        'shob', 'sob', 'taka', 'poysha', 'aschi', 'aschis', 'eta', 'ota', 'kothay',
        'kothakar', 'hobe', 'hoyeche', 'hyeche', 'dekhe', 'chobi', 'ektu', 'ekdom',
        'patha', 'pathabi', 'pathaben', 'shono', 'shuncho', 'keno', 'ken', 'tai',
        'halka', 'bujte', 'bujhechi', 'parbo', 'parbona', 'ashuk', 'bondhu', 'dada'
    ];

    const hinglishWords = [
        'kya', 'hai', 'hain', 'kaise', 'kaisa', 'kaisi', 'kar', 'raha', 'rahi',
        'rahe', 'batao', 'bataiye', 'paise', 'rupaye', 'bhej', 'bhejo', 'dekh',
        'dekho', 'mera', 'meri', 'mere', 'tera', 'teri', 'tere', 'apna', 'apni',
        'kab', 'kahan', 'nahi', 'nhi', 'haan', 'accha', 'acha', 'suno', 'sun',
        'chahiye', 'mang', 'dena', 'karo', 'mujhe', 'tujhe', 'hoga', 'hogi', 'yaar'
    ];

    let banglishHits = 0;
    let hinglishHits = 0;

    for (const w of banglishWords) {
        if (tokens.has(w)) banglishHits++;
    }
    for (const w of hinglishWords) {
        if (tokens.has(w)) hinglishHits++;
    }

    if (banglishHits > 0 && banglishHits >= hinglishHits) return 'Banglish';
    if (hinglishHits > 0) return 'Hinglish';
    return 'English';
}

function isDirectMoneyRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const moneyTerms = /(?:money|cash|taka|rupaye|paise|bucks|dollars|funds|₹|rs\.?|inr)/i;
    const actionTerms = /(?:send|give|transfer|pay|lend|borrow|loan|need|want|chahiye|bhej|bhejo|de\s*do|patha|pathabi|lagbe|dhar|udhar)/i;

    if (actionTerms.test(lower) && moneyTerms.test(lower)) return true;
    if (/(?:[0-9]+\s*(?:₹|rs\.?|taka|rupaye|paise|bucks)).*(?:send|de|bhej|patha|chahiye|lagbe|transfer|please)/i.test(lower)) return true;
    if (/(?:send|bhej|patha|give|transfer).*(?:[0-9]+)/i.test(lower) && /(?:₹|rs\.?|taka|rupaye|paise|money|cash)/i.test(lower)) return true;

    return false;
}

function getMoneyGuardrailReply(detectedLang) {
    if (detectedLang === 'Banglish') {
        return "Ami toh Master-er AI, tai taka-poysha ba boro kono decision ami nite parbo na. Master ashuk, oita o-i dekhbe! 😊";
    }
    if (detectedLang === 'Hinglish') {
        return "Main toh bas Master ka AI hoon, toh paise ya koi financial faisla main nahi le sakta. Master aayenge tab wahi decide karenge! 😊";
    }
    if (detectedLang === 'Bengali') {
        return "আমি মাস্টারের এআই, তাই টাকা-পয়সার ব্যাপারে কোনো সিদ্ধান্ত নিতে পারব না। মাস্টার এলে ও নিজেই দেখবে! 😊";
    }
    if (detectedLang === 'Hindi') {
        return "मैं तो बस मास्टर का एआई हूँ, इसलिए पैसों का कोई फैसला मैं नहीं ले सकता। मास्टर आएंगे तो वही देखेंगे! 😊";
    }
    // Default to English
    return "I'm just Master's AI, so I can't handle money or financial transactions! Let Master come back and he'll sort this out. 😊";
}

// -------------------------------------------------------------
// Core AI Processing Pipeline
// -------------------------------------------------------------
async function processSingleMessage(msg, body, pushName, cleanPhone, contactConfig) {
    const remoteJid = msg.key.remoteJid;

    log('AI', `Processing AI response for ${pushName}: "${body.slice(0, 45)}${body.length > 45 ? '...' : ''}"`);
    try {
        // 🛡️ Stealth Presence: Come online & show typing ONLY when actively replying to an approved contact
        await sock.sendPresenceUpdate('available').catch(() => {});
        await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

        let replyText = '';
        const detectedLang = detectMessageLanguage(body);

        // Media and special type handling fallbacks
        if (body === '[Sticker]') {
            replyText = '😄👌';
        } else if (body.startsWith('[Voice Note / Audio Message]')) {
            replyText = "I cannot hear audios, let's wait for Rishav to come back online! 🎧🔇";
        } else if (body.startsWith('[Photo / Image]')) {
            replyText = "I can't view images, let's wait for Rishav to come back online! 👀📸";
        } else if (body.startsWith('[Video]')) {
            replyText = "I cannot view videos, let's wait for Rishav to come back online! 🎬🍿";
        } else if (body.startsWith('[Document / File]')) {
            replyText = "I cannot open files or documents, let's wait for Rishav to come back online! 📄📎";
        } else if (PURE_EMOJI_REGEX.test(body)) {
            replyText = getEmojiFallback(body);
        } else if (isDirectMoneyRequest(body)) {
            // 🛡️ Deterministic Language-Accurate Money Defense Guardrail
            replyText = getMoneyGuardrailReply(detectedLang);
            log('FILTER', `Defended direct money request in ${detectedLang}: "${body.slice(0, 30)}..."`);
        }

        if (!replyText) {
            const history = getHistory(remoteJid);
            addToHistory(remoteJid, 'user', body);

            const promptToUse = (contactConfig?.customPrompt && contactConfig.customPrompt.trim().length > 0)
                ? contactConfig.customPrompt.trim()
                : config.defaultSystemPrompt;

            const languageDirective = `CRITICAL LANGUAGE DIRECTIVE FOR THIS RESPONSE:
The user's latest message is written in ${detectedLang.toUpperCase()}.
You MUST reply strictly and 100% in ${detectedLang.toUpperCase()}!
- If ENGLISH: Reply in natural English. Do NOT use any Bengali, Hindi, or mixed words.
- If BANGLISH: Reply in colloquial Banglish with natural transliteration spellings.
- If HINGLISH: Reply in colloquial Hinglish with natural transliteration spellings.
Never mix or respond in a different language than what the user used.`;

            const messagesPayload = [
                { role: 'system', content: `${promptToUse}\n\n${languageDirective}` },
                ...history
            ];

            const modelToUse = config.model || 'qwen/qwen3.8-27b';
            const result = await executeGroqWithPool(
                messagesPayload,
                modelToUse,
                config.temperature,
                config.maxTokens
            );

            replyText = result.reply;
        }

        if (replyText) {
            addToHistory(remoteJid, 'assistant', replyText);

            // Once-per-day introduction greeting
            const todayIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
            const lastGreeting = contactConfig.lastGreetingDate;

            let finalMessage = replyText;
            if (!lastGreeting || lastGreeting !== todayIST) {
                const greetingHeader = "Hello, I am Rishav's AI. Currently Master is offline, and I will be conversing with you on his behalf. 😊";
                finalMessage = `${greetingHeader}\n\n${replyText}`;
                contactConfig.lastGreetingDate = todayIST;
                saveConfig();
                log('INFO', `Attached once-per-day introduction greeting for ${pushName} (${todayIST})`);
            }

            await sock.sendMessage(remoteJid, { text: finalMessage }, { quoted: msg });
            stats.repliesSent++;
            log('SUCCESS', `Replied to ${pushName}: "${finalMessage.slice(0, 60)}${finalMessage.length > 60 ? '...' : ''}"`);
        }
    } catch (err) {
        log('ERROR', `Groq Pool Error for ${pushName}: ${err.message}`);
    } finally {
        try {
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
            // Immediately drop back to OFFLINE as soon as response is finished
            setTimeout(async () => {
                try {
                    if (sock && connectionStatus === 'CONNECTED') {
                        await sock.sendPresenceUpdate('unavailable').catch(() => {});
                    }
                } catch (_) {}
            }, 1000);
        } catch (_) {}
    }
}

// -------------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------------

// System Status & Real-time Info
app.get('/api/status', (req, res) => {
    const keyPool = getActiveKeyPool();
    res.json({
        status: connectionStatus,
        qr: currentQR,
        pairingCode: currentPairingCode,
        connectedUser,
        masterEnabled: config.masterEnabled,
        whitelistMode: config.whitelistMode,
        model: config.model,
        defaultPrompt: config.defaultSystemPrompt,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        allowGroups: config.allowGroups,
        hasApiKey: keyPool.length > 0,
        keysCount: keyPool.length,
        keyStats: getKeyStats(),
        contacts: config.contacts,
        stats: {
            ...stats,
            uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000)
        },
        recentLogs
    });
});

// Production Health & Diagnostic Check
app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'UP',
        whatsapp: connectionStatus,
        connectedUser: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null,
        uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
        memoryMB: {
            rss: Math.round(mem.rss / (1024 * 1024)),
            heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
            heapTotal: Math.round(mem.heapTotal / (1024 * 1024))
        },
        groqPool: {
            totalKeys: getActiveKeyPool().length,
            activeModel: config.model,
            activeTierOrder: MODEL_TIERS
        },
        stats
    });
});

// Update System Configuration
app.post('/api/config', (req, res) => {
    const {
        masterEnabled,
        whitelistMode,
        model,
        defaultPrompt,
        groqApiKey,
        groqKeys,
        temperature,
        maxTokens,
        allowGroups
    } = req.body;

    if (typeof masterEnabled === 'boolean') config.masterEnabled = masterEnabled;
    if (typeof whitelistMode === 'string') config.whitelistMode = whitelistMode;
    if (typeof model === 'string') config.model = model;
    if (typeof defaultPrompt === 'string') config.defaultSystemPrompt = defaultPrompt;
    if (typeof groqApiKey === 'string' && groqApiKey.trim()) {
        config.groqApiKey = groqApiKey.trim();
        if (!config.groqKeys.includes(groqApiKey.trim())) {
            config.groqKeys.unshift(groqApiKey.trim());
        }
    }
    if (Array.isArray(groqKeys)) {
        config.groqKeys = groqKeys.filter(k => typeof k === 'string' && k.trim().length > 10);
    }
    if (typeof temperature === 'number') config.temperature = temperature;
    if (typeof maxTokens === 'number') config.maxTokens = maxTokens;
    if (typeof allowGroups === 'boolean') config.allowGroups = allowGroups;

    saveConfig();
    log('INFO', `Configuration updated. Groq key pool contains ${getActiveKeyPool().length} keys.`);
    res.json({ success: true, config, keyStats: getKeyStats() });
});

// Contact Whitelist Toggle
app.post('/api/contacts/toggle', (req, res) => {
    const { jid, enabled } = req.body;
    if (!jid) return res.status(400).json({ error: 'JID is required' });

    if (config.contacts[jid]) {
        config.contacts[jid].enabled = !!enabled;
        saveConfig();
        const contactName = config.contacts[jid].name || jid;
        log('INFO', `Contact "${contactName}" AI toggle set to ${enabled ? 'ENABLED' : 'DISABLED'}`);
        return res.json({ success: true, contact: config.contacts[jid] });
    }

    res.status(404).json({ error: 'Contact not found' });
});

// Add / Update Contact Details
app.post('/api/contacts/update', (req, res) => {
    let { jid, phone, name, customPrompt, enabled } = req.body;

    if (!jid && phone) {
        const cleanDigits = phone.replace(/\D/g, '');
        if (!cleanDigits) return res.status(400).json({ error: 'Invalid phone number' });
        jid = `${cleanDigits}@s.whatsapp.net`;
    }

    if (!jid) return res.status(400).json({ error: 'JID or Phone number is required' });

    const cleanPhone = jid.split('@')[0];
    const existing = config.contacts[jid] || {};

    config.contacts[jid] = {
        name: name !== undefined ? name : (existing.name || cleanPhone),
        phone: cleanPhone,
        enabled: enabled !== undefined ? !!enabled : (existing.enabled !== undefined ? existing.enabled : true),
        customPrompt: customPrompt !== undefined ? customPrompt : (existing.customPrompt || ''),
        lastGreetingDate: existing.lastGreetingDate || null,
        lastActive: existing.lastActive || Date.now(),
        lastMessage: existing.lastMessage || ''
    };

    saveConfig();
    log('INFO', `Contact ${config.contacts[jid].name} (+${cleanPhone}) saved.`);
    res.json({ success: true, contact: config.contacts[jid] });
});

// Delete Contact
app.delete('/api/contacts/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    if (config.contacts[jid]) {
        const contactName = config.contacts[jid].name;
        delete config.contacts[jid];
        conversationHistory.delete(jid);
        saveConfig();
        log('INFO', `Removed contact "${contactName}" (${jid}) from list.`);
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'Contact not found' });
});

// Clear In-Memory Conversation History (Context Memory)
app.post('/api/history/clear', (req, res) => {
    const { jid } = req.body;
    if (jid) {
        conversationHistory.delete(jid);
        log('INFO', `Cleared conversation context memory for ${jid}.`);
    } else {
        conversationHistory.clear();
        log('INFO', 'Cleared conversation context memory for all contacts.');
    }
    res.json({ success: true, message: 'Conversation context reset.' });
});

// Request Pairing Code by Phone Number
app.post('/api/auth/pairing-code', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (cleanNumber.length < 8) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!sock || connectionStatus === 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp is already connected or socket is not ready.' });
    }

    try {
        log('INFO', `Requesting 8-digit Pairing Code for +${cleanNumber}...`);
        const code = await sock.requestPairingCode(cleanNumber);
        currentPairingCode = code;
        log('SUCCESS', `Pairing code generated: ${code}`);
        res.json({ success: true, code });
    } catch (err) {
        log('ERROR', `Failed to generate pairing code: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Restart WhatsApp Connection
app.post('/api/auth/restart', (req, res) => {
    log('INFO', 'Manual restart initiated from dashboard...');
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    cleanupCurrentSocket();
    setTimeout(startWhatsApp, 2000);
    res.json({ success: true, message: 'Restarting WhatsApp socket...' });
});

// Disconnect and Logout
app.post('/api/auth/logout', async (req, res) => {
    log('INFO', 'Logging out and clearing session credentials...');
    try {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (sock) {
            try {
                await sock.logout();
            } catch (_) {}
        }
        cleanupCurrentSocket();
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        if (process.env.MONGODB_URI) {
            await clearMongoAuth('auth_sessions').catch(() => {});
        }
        connectionStatus = 'DISCONNECTED';
        currentQR = null;
        currentPairingCode = null;
        connectedUser = null;
        setTimeout(startWhatsApp, 2500);
        res.json({ success: true, message: 'Logged out successfully. Generating fresh QR...' });
    } catch (err) {
        log('ERROR', `Logout error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Test Groq API Key Pool
app.post('/api/groq/test', async (req, res) => {
    const { model } = req.body;

    try {
        const result = await executeGroqWithPool(
            [{ role: 'user', content: 'Say "Groq Pool Connected!" in 4 words or less.' }],
            model || config.model || 'qwen/qwen3.8-27b',
            0.5,
            80
        );

        log('SUCCESS', `Groq pool test successful via Key #${result.keyIndex} (${result.keyUsed}) using ${result.modelUsed}: "${result.reply}"`);
        res.json({
            success: true,
            reply: result.reply,
            keyUsed: result.keyUsed,
            keyIndex: result.keyIndex,
            modelUsed: result.modelUsed,
            keyStats: getKeyStats()
        });
    } catch (err) {
        log('ERROR', `Groq pool test failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Clear Logs
app.post('/api/logs/clear', (req, res) => {
    recentLogs = [];
    res.json({ success: true });
});

// -------------------------------------------------------------
// Uncaught Error Guards & Graceful Process Lifecycle
// -------------------------------------------------------------
process.on('uncaughtException', (err) => {
    log('ERROR', `[CRITICAL] Uncaught Exception: ${err.message}`);
    originalConsoleError(err);
});

process.on('unhandledRejection', (reason) => {
    log('ERROR', `[CRITICAL] Unhandled Rejection: ${reason}`);
});

function handleExit(signal) {
    log('INFO', `Received ${signal}. Shutting down cleanly...`);
    saveConfig();
    cleanupCurrentSocket();
    process.exit(0);
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

// -------------------------------------------------------------
// Start Server
// -------------------------------------------------------------
app.listen(PORT, () => {
    originalConsoleLog(`====================================================`);
    originalConsoleLog(`🚀 AI WhatsApp Bridge Server listening on port ${PORT}`);
    originalConsoleLog(`🔑 Groq Multi-Key Pool loaded with ${getActiveKeyPool().length} keys`);
    originalConsoleLog(`🧠 Primary Model: ${config.model} (Max Tokens: ${config.maxTokens})`);
    originalConsoleLog(`🌐 Control Dashboard: http://localhost:${PORT}`);
    originalConsoleLog(`====================================================`);
    startWhatsApp();
});
