# Simple AI WhatsApp Bridge - Implementation Plan

## 1. Overview & Objective
Build a lightweight, clean, and reliable WhatsApp AI bridge that replaces the previous monolithic multi-layered architecture. 

### Core Design Goals:
- **Zero Bloat**: Under ~250 lines of core backend code (down from 3,400+ lines).
- **Direct Groq Integration**: Ultra-fast responses (~500ms) powered by Groq's LPU inference engine (`llama-3.3-70b-versatile`).
- **No Database Headaches**: Uses Baileys' native local file storage (`useMultiFileAuthState`)—no MongoDB session sync corruptions, no Signal Bad MAC errors.
- **Control Dashboard**: A clean, modern web interface to:
  * Scan WhatsApp QR code to link your account.
  * Toggle the Master AI Switch (Pause/Resume).
  * **Whitelist Contacts**: Selectively enable AI only for specific phone numbers or contacts.
  * Customize system prompts and AI personality per contact or globally.
  * Live message logs.

---

## 2. Architecture & Data Flow

```
┌───────────────────────────────────────────────────────────────┐
│                      Web Dashboard (Browser)                  │
│  - Live QR Code Display                                       │
│  - Contact Whitelist Toggles (Enable/Disable AI per number)   │
│  - Custom Prompt Configuration & Master Switch                │
└──────────────────────────────┬────────────────────────────────┘
                               │ REST / WebSocket
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                 Express Backend (server.js)                   │
│                                                               │
│   ┌───────────────────────────┐    ┌───────────────────────┐  │
│   │   Baileys Socket Client   │    │      config.json      │  │
│   │  (useMultiFileAuthState)  │    │  (Whitelisted numbers,│  │
│   └─────────────┬─────────────┘    │   prompts, settings)  │  │
│                 │                  └───────────┬───────────┘  │
│                 ▼                              │              │
│        Incoming Message (upsert)               │              │
│                 │                              │              │
│                 ├── Is sender in whitelist? ───┘              │
│                 │   (NO: Ignore completely)                   │
│                 ▼ (YES)                                       │
│          Send Typing Indicator                                │
│                 │                                             │
│                 ▼                                             │
│        Call Groq API (Chat Completion)                        │
│                 │                                             │
│                 ▼                                             │
│        Send Reply via Baileys                                 │
└─────────────────┬─────────────────────────────────────────────┘
                  │
                  ▼
         WhatsApp Web Gateway
```

---

## 3. Project Directory Structure

```
Secret Whatsapp/
└── AI Whatsapp/
    ├── implementation.md          <-- This plan
    ├── package.json               <-- Minimal dependencies
    ├── config.json                <-- Whitelist, prompts, settings
    ├── server.js                  <-- Single clean server script (~200 lines)
    ├── auth_info_baileys/         <-- Auto-created session files (git-ignored)
    └── public/
        ├── index.html             <-- Modern dark-mode dashboard
        ├── styles.css             <-- Clean CSS styling
        └── app.js                 <-- Dashboard UI logic & live status
```

---

## 4. Technology Stack & Dependencies

### Backend
* **Runtime**: Node.js (v18+)
* **WhatsApp Engine**: `@whiskeysockets/baileys` (^6.7.x)
* **Server**: `express` + `cors`
* **AI Provider**: `groq-sdk` (or direct fetch to Groq's OpenAI-compatible completions endpoint)
* **QR Generator**: `qrcode` (renders QR code directly to a data URL for display on the dashboard)

### Frontend Dashboard
* **Vanilla HTML5, CSS3, & Modern JS** (lightweight, zero build step required).

---

## 5. Step-by-Step Implementation

### Step 1: `package.json`
```json
{
  "name": "ai-whatsapp-simple",
  "version": "1.0.0",
  "description": "Clean, lightweight WhatsApp to Groq AI bridge with contact whitelist dashboard",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.13",
    "cors": "^2.8.5",
    "express": "^4.21.2",
    "groq-sdk": "^0.9.0",
    "pino": "^9.6.0",
    "qrcode": "^1.5.4"
  }
}
```

---

### Step 2: Configuration Storage (`config.json`)
Persistent local configuration that can be updated in real time from the dashboard:
```json
{
  "masterEnabled": true,
  "groqApiKey": "gsk_...",
  "model": "llama-3.3-70b-versatile",
  "defaultSystemPrompt": "You are a helpful, concise personal assistant replying on WhatsApp. Keep responses brief and friendly.",
  "whitelistMode": "only_whitelisted", 
  "contacts": {
    "919876543210@s.whatsapp.net": {
      "name": "Alex",
      "enabled": true,
      "customPrompt": "Reply casually and like a close friend."
    },
    "911234567890@s.whatsapp.net": {
      "name": "Work Client",
      "enabled": false,
      "customPrompt": "Reply with utmost professionalism and ask them to email me if urgent."
    }
  }
}
```

---

### Step 3: Core Server Implementation (`server.js`)
Clean and direct flow:

```javascript
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
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 4000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load / Save Config
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({
            masterEnabled: true,
            groqApiKey: process.env.GROQ_API_KEY || '',
            model: 'llama-3.3-70b-versatile',
            defaultSystemPrompt: 'You are a helpful, concise personal AI assistant replying on WhatsApp.',
            whitelistMode: 'only_whitelisted',
            contacts: {}
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}
let config = loadConfig();
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let sock = null;
let currentQR = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED | QR_READY | CONNECTED
let recentLogs = [];

function log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
}

// WhatsApp Baileys Connection
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionStatus = 'QR_READY';
            currentQR = await QRCode.toDataURL(qr);
            log('New QR Code generated. Scan from the dashboard!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'DISCONNECTED';
            currentQR = null;
            log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = 'CONNECTED';
            currentQR = null;
            log('WhatsApp connection successfully established!');
        }
    });

    // Incoming Message Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg || msg.key.fromMe) return; // Ignore own messages

        const senderJid = msg.key.remoteJid;
        const isGroup = senderJid.endsWith('@g.us');
        if (isGroup) return; // Skip groups by default

        const body = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text;
        if (!body) return;

        // 1. Check Master Switch
        if (!config.masterEnabled) {
            log(`Master switch is OFF. Ignored message from ${senderJid}`);
            return;
        }

        // 2. Check Whitelist
        const contactConfig = config.contacts[senderJid];
        const isWhitelisted = contactConfig && contactConfig.enabled;

        if (config.whitelistMode === 'only_whitelisted' && !isWhitelisted) {
            // Register contact in config if new, but keep disabled
            if (!contactConfig) {
                config.contacts[senderJid] = {
                    name: msg.pushName || senderJid.replace('@s.whatsapp.net', ''),
                    enabled: false,
                    customPrompt: ''
                };
                saveConfig();
            }
            log(`Ignoring message from non-whitelisted sender: ${senderJid}`);
            return;
        }

        // 3. Process with Groq
        log(`Processing AI reply for ${msg.pushName || senderJid}: "${body.slice(0, 30)}..."`);
        try {
            await sock.sendPresenceUpdate('composing', senderJid);

            const groq = new Groq({ apiKey: config.groqApiKey });
            const systemPrompt = contactConfig?.customPrompt?.trim() || config.defaultSystemPrompt;

            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: body }
                ],
                model: config.model || 'llama-3.3-70b-versatile',
                temperature: 0.7,
                max_tokens: 300
            });

            const reply = chatCompletion.choices[0]?.message?.content?.trim();
            if (reply) {
                await sock.sendMessage(senderJid, { text: reply }, { quoted: msg });
                log(`Sent AI reply to ${senderJid}`);
            }
        } catch (err) {
            log(`Error generating Groq response: ${err.message}`);
        } finally {
            await sock.sendPresenceUpdate('paused', senderJid);
        }
    });
}

// REST API for Dashboard
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: currentQR,
        masterEnabled: config.masterEnabled,
        contacts: config.contacts,
        model: config.model,
        defaultPrompt: config.defaultSystemPrompt,
        recentLogs
    });
});

app.post('/api/config', (req, res) => {
    const { masterEnabled, contacts, defaultPrompt, model, groqApiKey } = req.body;
    if (typeof masterEnabled === 'boolean') config.masterEnabled = masterEnabled;
    if (contacts) config.contacts = contacts;
    if (defaultPrompt) config.defaultSystemPrompt = defaultPrompt;
    if (model) config.model = model;
    if (groqApiKey) config.groqApiKey = groqApiKey;
    saveConfig();
    res.json({ success: true, config });
});

app.post('/api/contacts/toggle', (req, res) => {
    const { jid, enabled } = req.body;
    if (config.contacts[jid]) {
        config.contacts[jid].enabled = enabled;
        saveConfig();
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'Contact not found' });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    startWhatsApp();
});
```

---

### Step 4: Clean Dashboard UI (`public/index.html`)

A modern, responsive dark-mode control center:

#### Key UI Elements:
1. **Connection Header**:
   * WhatsApp status badge (`Connected` 🟢 / `Scan QR` 🟡 / `Disconnected` 🔴).
   * Big QR code display box when status is `QR_READY`.
2. **Master Control Card**:
   * Master Toggle: **AI Auto-Responder: ON / OFF**.
   * Model selector (e.g. `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`).
   * Default Global System Prompt input.
3. **Contact Manager & Whitelist Table**:
   * Displays all recognized incoming contacts with their Name and Phone Number.
   * **Active Switch (ON/OFF)**: Selectively decide who gets AI replies.
   * **Custom Personality / Prompt field**: Expandable per-contact prompt override.
   * Quick button: **"Add New Number Manually"**.
4. **Live Activity Console**:
   * Terminal-like feed showing real-time messages received, evaluated, and answered.

---

## 6. How This Solves the Previous Issues

| Previous Problem | Root Cause | New Solution |
| :--- | :--- | :--- |
| **Messages not coming / going** | Signal encryption keys desynchronized across MongoDB collections | Local multi-file auth stores cryptographic keys directly on disk with zero sync latency. |
| **High complexity (3,400+ lines)** | Multi-layered fake API disguise, MongoDB pooling, Bad MAC interceptors | Stripped to essential Baileys + Groq pipeline (< 250 lines total). |
| **Lack of control over who gets AI** | Hardcoded or complex logic | Simple UI table where you click ON/OFF for any contact. |
| **Speed / Delay** | Slow server roundtrips and proxy hops | Groq LPU responds in under 0.5 seconds, then replies directly. |

---

## 7. Next Steps for Execution
1. Create `AI Whatsapp/` directory.
2. Initialize clean `package.json` and install dependencies.
3. Implement `server.js` and `public/` dashboard files.
4. Add your Groq API key in `.env` or the Dashboard.
5. Launch `npm start`, scan the QR code in the browser at `http://localhost:4000`, and toggle your desired contacts.
