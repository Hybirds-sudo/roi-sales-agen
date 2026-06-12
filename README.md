# VocalROI Unibox AI 🤖

Your own AI that watches the Instantly inbox, **auto-replies to interested leads**, and
**pings you on Telegram** the moment a hot lead comes in. This is *your* agent — it does
not use Instantly's built-in sales agent.

## What it does (every 5 minutes)
1. Checks your Instantly inbox for new replies
2. Uses **Claude (Opus 4.8)** to read each reply and decide the intent
   (interested / question / not interested / unsubscribe / auto-reply)
3. For interested leads & questions → drafts a warm, on-brand reply
4. **Sends it automatically** (if `AUTO_SEND=true`) via your Instantly account
5. **Telegram alert:** `🔥 INTERESTED LEAD — [name], [what they said], [reply sent]`
6. Remembers what it handled (in `processed.json`) so nothing is answered twice

---

## Setup (about 5 minutes, one time)

### 1. Get the 3 missing keys
| Key | Where to get it |
|---|---|
| **Anthropic API key** | https://console.anthropic.com → Settings → API Keys → Create. Starts with `sk-ant-...` |
| **Telegram bot token** | In Telegram, message **@BotFather** → `/newbot` → follow prompts → it gives you a token like `12345:AA...` |
| **Telegram chat id** | In Telegram, message **@userinfobot** → it replies with your numeric id |

*(Your Instantly key is already filled in.)*

### 2. Create your config file
- Copy `.env.example` to `.env`
- Paste the 3 values you just got into `.env`

### 3. Install + run
```powershell
cd C:\Users\Ego\Desktop\VocalROI\Sales\unibox-ai
npm install
npm start
```
You should get a Telegram message: *"🤖 VocalROI Unibox AI is live."*

That's it. Leave it running and it watches your inbox. Press `Ctrl+C` to stop.

---

## Settings (in `.env`)
- `AUTO_SEND=true` → AI sends replies automatically + alerts you.
  Set `false` to get the **draft** on Telegram and send it yourself (safer while you build trust in it).
- `POLL_INTERVAL_MINUTES=5` → how often it checks.
- `SIGNATURE_NAME=Bakhtiyor` → how replies are signed.

## Run it once (test)
```powershell
npm run once
```

## Keep it running 24/7 (optional)
Easiest: leave the terminal open. To run it in the background even after closing the
window, use Windows Task Scheduler to launch `node unibox-ai.js` at login, or ask Claude
to set that up for you.

---

## Notes
- The **first launch** marks your current replies as "already seen" so it doesn't blast
  old threads. From then on, only *new* replies are handled. (To process the existing
  backlog instead, delete `processed.json` after editing the priming block in `unibox-ai.js`.)
- If a reply errors out, you still get a Telegram alert telling you to handle that one manually.
- Costs: a few cents a day in Anthropic tokens at normal reply volume.
