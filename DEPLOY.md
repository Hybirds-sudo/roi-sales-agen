# Deploy Unibox AI to Railway (24/7 cloud)

Runs your Unibox AI in the cloud so it watches the inbox forever — no need to keep your
PC on. The free Hobby plan is plenty (it's a tiny worker).

## GitHub → Railway (recommended)

### 1. Push this folder to a PRIVATE GitHub repo
`.env` is gitignored, so your real keys never get committed.

### 2. Create the project on Railway
1. https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Authorize Railway's GitHub app, then pick your `unibox-ai` repo
3. Railway auto-detects Node and uses `railway.json` to run `node unibox-ai.js`

### 3. Add your environment variables
In the service → **Variables** tab, add each (use YOUR real values):

| Variable | Value |
|---|---|
| `INSTANTLY_API_KEY` | your Instantly key |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `OPENROUTER_MODEL` | `openrouter/free` |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `TELEGRAM_CHAT_ID` | your chat id |
| `POLL_INTERVAL_MINUTES` | `5` |
| `AUTO_SEND` | `true` |
| `SIGNATURE_NAME` | `Bakhtiyor` |
| `STATE_FILE` | `/data/processed.json` |

### 4. Add a persistent volume (so it remembers handled leads across restarts)
Service → **Settings** → **Volumes** → mount at `/data`.

### 5. Deploy
Railway deploys automatically. You'll get the "🤖 Unibox AI is live" Telegram message
on boot. Every future `git push` redeploys.

## After it's live
- **Stop the local copy** so it doesn't run in two places (double-replies).
- Health status is at the Railway-provided URL (returns JSON).
- For draft-only review mode, set `AUTO_SEND=false` in Variables and redeploy.

## Notes
- Costs: tiny worker; OpenRouter model is free. Railway Hobby ≈ $5/mo usage credit.
- Without the `/data` volume, a redeploy re-primes state (won't blast old threads, but a
  lead who replies during a redeploy could be missed). The volume makes it bulletproof.
