# 🤖 WhatsApp AI Companion & Assistant

An intelligent, 24/7 production-ready AI companion for WhatsApp built on **Baileys** and **Groq Cloud LPU** with multi-key failover and MongoDB Atlas session persistence.

---

## 🌟 Key Features

1. **24/7 Cloud Resilience & Anti-Wipe Persistence**:
   - Stores session encryption keys and rotating ratchets in **MongoDB Atlas** so your login session survives ephemeral container restarts on Render.
   - Built-in automatic migration: syncs your active local WhatsApp session to MongoDB Atlas on startup.
2. **5-Key Groq LPU Load Balancing**:
   - Round-robin key pool distributing traffic across multiple Groq API keys.
   - Automatic HTTP 429 rate-limit circuit breakers with 30-second cooldowns and model tier fallbacks (`qwen/qwen3.8-27b` $\rightarrow$ `openai/gpt-oss-20b` $\rightarrow$ `openai/gpt-oss-120b`).
3. **Stealth Presence & Anti-Detection**:
   - `markOnlineOnConnect: false` keeps your WhatsApp status as Offline by default.
   - Pulses "online" briefly only when actively responding to messages, then returns to offline.
4. **Selective Contact Whitelist**:
   - Master Switch to pause/resume AI replies anytime.
   - Per-contact toggle: whitelist only specific contacts to receive AI responses.
   - Strict or permissive whitelist modes with custom per-contact prompts.
5. **Modern Dark-Mode Dashboard**:
   - WhatsApp QR Code and 8-digit Pairing Code generator.
   - Real-time key pool status with live cooldown countdowns.
   - Live activity console feed and conversation context reset button.
6. **24/7 Keep-Alive Probes**:
   - `/healthz` and `/ping` endpoints for free uptime monitors (cron-job.org / UptimeRobot).

---

## 🚀 Local Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure .env (copy from .env.example)
cp .env.example .env

# 3. Start the application
npm start
```

Access the dashboard at `http://localhost:4000`.

---

## ☁️ 24/7 Deployment on Render (100% Free)

### 1. MongoDB Atlas Setup (Free 512MB)
1. Sign up at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas).
2. Create an **M0 Free Shared Cluster**.
3. Under **Database Access**, create a user with read/write access.
4. Under **Network Access**, add `0.0.0.0/0` (Allow access from anywhere).
5. Copy your connection URI:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 2. Deploy to Render
1. Create a new **Web Service** on [dashboard.render.com](https://dashboard.render.com).
2. Connect your GitHub repository `https://github.com/rishwebb/Whatsapp-AI`.
3. Set the following environment variables in Render:
   - `MONGODB_URI`: `mongodb+srv://...`
   - `GROQ_API_KEY`: *(your primary Groq API key)*
   - `GROQ_API_KEY_2`, `GROQ_API_KEY_3`, `GROQ_API_KEY_4`, `GROQ_API_KEY_5`
4. Deploy!

### 3. Keep Awake with Uptime Monitor
Add a free monitor on [cron-job.org](https://cron-job.org) or [uptimerobot.com](https://uptimerobot.com):
- **URL**: `https://<your-render-app>.onrender.com/healthz`
- **Interval**: Every 10 minutes
- **Method**: `GET`
