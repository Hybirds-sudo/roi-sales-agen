// VocalROI Unibox AI (OpenRouter edition)
// Polls the Instantly inbox for new replies, uses a free OpenRouter model to classify
// intent and draft a reply, optionally auto-sends it, and pings you on Telegram for
// every interested lead. State is kept in processed.json so nothing is handled twice.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Config ----------------------------------------------------------------
const {
  INSTANTLY_API_KEY,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = "openrouter/free",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = "5",
  AUTO_SEND = "true",
  SIGNATURE_NAME = "Bakhtiyor",
} = process.env;

for (const [k, v] of Object.entries({
  INSTANTLY_API_KEY,
  OPENROUTER_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
})) {
  if (!v) {
    console.error(`Missing ${k} in .env — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const AUTO = String(AUTO_SEND).toLowerCase() === "true";
// STATE_FILE can point at a Railway volume (e.g. /data/processed.json) so state
// survives redeploys. Defaults to the app folder for local use.
const STATE_FILE = process.env.STATE_FILE || join(__dirname, "processed.json");
const INSTANTLY = "https://api.instantly.ai/api/v2";

// Lightweight runtime status, exposed via the health endpoint on Railway.
const status = { startedAt: new Date().toISOString(), lastCheck: null, lastResult: "starting", handled: 0 };

const SYSTEM_PROMPT = `You are the inbox assistant for ${SIGNATURE_NAME} at VocalROI.
VocalROI sells an AI phone agent for home-service businesses (roofing, HVAC, plumbing).
The agent answers every call 24/7, books the job, or transfers hot calls to the owner's cell.
The cold-email offer is a FREE personalized demo: we build an agent with the prospect's company
name on it and have it call them so they can hear it.

You read one inbound email reply and decide how to respond. Return ONLY raw JSON (no markdown,
no code fences) with exactly this shape:
{
  "intent": "interested" | "question" | "not_interested" | "auto_reply" | "unsubscribe" | "other",
  "should_reply": true or false,
  "reply": "the plain-text reply to send, or empty string if should_reply is false",
  "summary": "one short line describing what the lead said"
}

Rules:
- "interested" = they want the demo, ask to learn more, give a phone number, or say yes. should_reply true.
- "question" = they asked something (price, how it works). should_reply true. Answer briefly, then steer to the free demo.
- "not_interested" = polite no. should_reply true. Reply graciously, leave the door open, no pressure.
- "unsubscribe" = they want out / "remove me" / "stop". should_reply false.
- "auto_reply" = out-of-office / autoresponder / bounce. should_reply false.
- Keep replies short (2-4 sentences), warm, human, no corporate fluff, no links.
- When they're interested, ask for their best cell number so we can build the demo and have it call them.
- Sign every reply exactly as: ${SIGNATURE_NAME}
- Never invent pricing numbers; if pressed on price, say it depends on call volume and offer the free demo first.`;

// ---- Helpers ---------------------------------------------------------------
function loadState() {
  if (!existsSync(STATE_FILE)) return { processed: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { processed: [] };
  }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function instantly(path, options = {}) {
  const res = await fetch(`${INSTANTLY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${INSTANTLY_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Instantly ${path} -> ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function telegram(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    }
  );
  if (!res.ok) console.error("Telegram error:", await res.text());
}

// Pull the first {...} JSON object out of a model response, even if wrapped in prose/fences.
function extractJson(text) {
  if (!text) throw new Error("empty model response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON found in model response");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function classifyAndDraft(email) {
  const fromName = email.from_address_json?.[0]?.name || email.from_address_email;
  const userContent = `From: ${fromName} <${email.from_address_email}>
Subject: ${email.subject}

${(email.body?.text || email.content_preview || "").slice(0, 4000)}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "VocalROI Unibox AI",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  return extractJson(content);
}

async function sendReply(email, replyText) {
  return instantly("/emails/reply", {
    method: "POST",
    body: JSON.stringify({
      reply_to_uuid: email.id,
      eaccount: email.eaccount,
      subject: email.subject?.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
      body: { text: replyText },
    }),
  });
}

// ---- Main cycle ------------------------------------------------------------
async function checkInbox() {
  const state = loadState();
  const seen = new Set(state.processed);

  status.lastCheck = new Date().toISOString();
  const data = await instantly("/emails?email_type=received&limit=50");
  const emails = data.items || [];
  const fresh = emails.filter((e) => !seen.has(e.id));

  if (fresh.length === 0) {
    status.lastResult = "no new replies";
    console.log(`[${new Date().toLocaleString()}] No new replies.`);
    return;
  }
  status.lastResult = `processing ${fresh.length}`;
  console.log(`[${new Date().toLocaleString()}] ${fresh.length} new repl${fresh.length === 1 ? "y" : "ies"} to process.`);

  fresh.sort((a, b) => new Date(a.timestamp_email) - new Date(b.timestamp_email));

  for (const email of fresh) {
    const fromName = email.from_address_json?.[0]?.name || email.from_address_email;
    try {
      const result = await classifyAndDraft(email);
      const hot = result.intent === "interested" || result.intent === "question";

      let actionLine;
      if (result.should_reply && result.reply) {
        if (AUTO) {
          await sendReply(email, result.reply);
          actionLine = "✅ AI reply sent automatically";
        } else {
          actionLine = "📝 Draft ready (AUTO_SEND is off — send it yourself)";
        }
      } else {
        actionLine = "⏭️ No reply sent (" + result.intent + ")";
      }

      if (hot || result.should_reply) {
        const flag = hot ? "🔥 INTERESTED LEAD" : "📩 New reply";
        await telegram(
          `${flag}\n\n` +
            `<b>${escapeHtml(fromName)}</b>\n` +
            `${escapeHtml(email.from_address_email)}\n\n` +
            `<b>They said:</b> ${escapeHtml(result.summary)}\n\n` +
            `<b>Intent:</b> ${result.intent}\n` +
            `<b>${actionLine}</b>\n\n` +
            (result.reply ? `<b>Reply:</b>\n${escapeHtml(result.reply)}` : "")
        );
      }
      console.log(`  • ${fromName}: ${result.intent} — ${actionLine}`);
    } catch (err) {
      console.error(`  ! Error on ${fromName}:`, err.message);
      await telegram(
        `⚠️ Unibox AI hit an error on a reply from <b>${escapeHtml(fromName)}</b>:\n${escapeHtml(
          err.message
        )}\n\nCheck this one manually.`
      );
    } finally {
      seen.add(email.id);
      status.handled++;
    }
  }

  state.processed = [...seen].slice(-2000);
  saveState(state);
  status.lastResult = `handled ${fresh.length} at ${new Date().toLocaleString()}`;
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Runner ----------------------------------------------------------------
async function main() {
  const once = process.argv.includes("--once");

  // Heartbeat endpoint for Railway / uptime checks (Railway sets PORT).
  if (process.env.PORT) {
    createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "vocalroi-unibox-ai", ...status }, null, 2));
    }).listen(process.env.PORT, () => console.log(`Health endpoint on :${process.env.PORT}`));
  }
  console.log(
    `VocalROI Unibox AI (OpenRouter: ${OPENROUTER_MODEL}) — AUTO_SEND=${AUTO}, every ${POLL_INTERVAL_MINUTES} min${
      once ? " (single run)" : ""
    }`
  );

  if (!existsSync(STATE_FILE)) {
    const data = await instantly("/emails?email_type=received&limit=50");
    const ids = (data.items || []).map((e) => e.id);
    saveState({ processed: ids });
    console.log(`Primed: marked ${ids.length} existing replies as already-seen. New ones from now on will be handled.`);
    await telegram("🤖 VocalROI Unibox AI is live. I'll alert you here the moment an interested lead replies.");
    if (once) return;
  }

  await checkInbox().catch((e) => console.error("Cycle error:", e.message));
  if (once) return;

  setInterval(
    () => checkInbox().catch((e) => console.error("Cycle error:", e.message)),
    Number(POLL_INTERVAL_MINUTES) * 60 * 1000
  );
}

main();
