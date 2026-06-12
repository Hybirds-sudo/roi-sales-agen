// VocalROI Unibox AI (OpenRouter + Vapi auto-demo edition)
// Watches the Instantly inbox. For every interested lead it:
//   1) classifies intent + drafts a reply (OpenRouter free model)
//   2) instantly creates a Vapi voice assistant BRANDED for that lead's company
//   3) when the lead shares a phone number, places a live demo call from your Vapi number
//   4) alerts you on Telegram at every step
// State lives in processed.json so nothing is handled (or called) twice.

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
  VAPI_PRIVATE_KEY,
  VAPI_PHONE_NUMBER_ID,
  VAPI_VOICE_ID = "Elliot",
  POLL_INTERVAL_MINUTES = "5",
  AUTO_SEND = "true",
  AUTO_CALL = "true",
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
const CALLING = String(AUTO_CALL).toLowerCase() === "true" && !!VAPI_PRIVATE_KEY && !!VAPI_PHONE_NUMBER_ID;
const STATE_FILE = process.env.STATE_FILE || join(__dirname, "processed.json");
const INSTANTLY = "https://api.instantly.ai/api/v2";
const VAPI = "https://api.vapi.ai";

const status = { startedAt: new Date().toISOString(), lastCheck: null, lastResult: "starting", handled: 0, calls: 0 };

const SYSTEM_PROMPT = `You are the inbox assistant for ${SIGNATURE_NAME} at VocalROI.
VocalROI sells an AI phone agent for home-service businesses (roofing, HVAC, plumbing).
The agent answers every call 24/7, books the job, or transfers hot calls to the owner's cell.
The cold-email offer is a FREE personalized demo: we build an agent with the prospect's company
name on it and have it CALL them so they can hear it.

You read one inbound email reply and decide how to respond. Return ONLY raw JSON (no markdown,
no code fences) with exactly this shape:
{
  "intent": "interested" | "question" | "not_interested" | "auto_reply" | "unsubscribe" | "other",
  "should_reply": true or false,
  "reply": "the plain-text reply to send, or empty string if should_reply is false",
  "phone": "any phone number the lead gave in E.164-ish digits, or empty string",
  "summary": "one short line describing what the lead said"
}

Rules:
- "interested" = they want the demo, ask to learn more, give a phone number, or say yes. should_reply true.
- "question" = they asked something (price, how it works). should_reply true. Answer briefly, then steer to the free demo.
- "not_interested" = polite no. should_reply true. Reply graciously, leave the door open, no pressure.
- "unsubscribe" = remove me / stop. should_reply false.
- "auto_reply" = out-of-office / autoresponder / bounce. should_reply false.
- Keep replies short (2-4 sentences), warm, human, no corporate fluff, no links.
- If they're interested but have NOT given a phone number, ask for their best cell so we can build
  the demo agent and have it call them in the next couple minutes.
- If they DID give a number, tell them their AI agent will call them in the next couple minutes so they can hear it.
- Extract any phone number they wrote into "phone" (digits only, with country code if present).
- Sign every reply exactly as: ${SIGNATURE_NAME}
- Never invent pricing; if pressed, say it depends on call volume and offer the free demo first.`;

// ---- Helpers ---------------------------------------------------------------
function loadState() {
  if (!existsSync(STATE_FILE)) return { processed: [], leads: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    s.leads = s.leads || {};
    s.processed = s.processed || [];
    return s;
  } catch {
    return { processed: [], leads: {} };
  }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function api(base, key, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${base}${path} -> ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.status === 204 ? {} : res.json();
}
const instantly = (path, options) => api(INSTANTLY, INSTANTLY_API_KEY, path, options);
const vapi = (path, options) => api(VAPI, VAPI_PRIVATE_KEY, path, options);

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

function extractJson(text) {
  if (!text) throw new Error("empty model response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON found in model response");
  return JSON.parse(candidate.slice(start, end + 1));
}

// US-friendly E.164 normalization. Returns "+1XXXXXXXXXX" or null.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.length >= 11 ? d : null;
  d = d.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
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
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return extractJson(data.choices?.[0]?.message?.content || "");
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

// Create a Vapi voice assistant branded for this lead's company.
async function createDemoAssistant(company, trade, ownerFirst) {
  const co = company || "your company";
  const t = trade || "home services";
  const assistant = await vapi("/assistant", {
    method: "POST",
    body: JSON.stringify({
      name: `Demo - ${co}`.slice(0, 40),
      firstMessage: `Thanks for calling ${co}! This is your AI receptionist — how can I help you today?`,
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are the friendly AI phone receptionist for ${co}, a ${t} business in the US.
You answer calls 24/7 so the owner never misses a job. Greet warmly, ask how you can help, and if the
caller needs service, collect their name, address, phone number, and a short description of the issue,
then say the team will confirm the appointment shortly. Keep it natural, upbeat, and brief.
This call is a live demo so the owner${ownerFirst ? " " + ownerFirst : ""} can hear how their AI receptionist sounds.`,
          },
        ],
      },
      voice: { provider: "vapi", voiceId: VAPI_VOICE_ID },
    }),
  });
  return assistant.id;
}

async function placeDemoCall(assistantId, phoneE164, company) {
  return vapi("/call", {
    method: "POST",
    body: JSON.stringify({
      assistantId,
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: { number: phoneE164 },
      name: `Demo call - ${company || ""}`.slice(0, 40),
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
    const leadEmail = email.from_address_email;
    try {
      const result = await classifyAndDraft(email);
      const hot = result.intent === "interested" || result.intent === "question";

      // remember/seed lead record (company/trade come from Instantly lead enrichment if present)
      const lead = (state.leads[leadEmail] = state.leads[leadEmail] || {});
      lead.name = fromName;
      lead.company = lead.company || email.lead?.company_name || guessCompany(leadEmail);

      const actions = [];

      // 1) create a branded demo assistant the first time a lead shows interest
      if (hot && CALLING && !lead.assistantId) {
        try {
          lead.assistantId = await createDemoAssistant(lead.company, lead.trade, (fromName || "").split(" ")[0]);
          actions.push(`🛠️ Built demo agent for ${lead.company}`);
        } catch (e) {
          actions.push(`⚠️ Assistant build failed: ${e.message.slice(0, 80)}`);
        }
      }

      // 2) if the lead gave a phone number, place the live demo call
      const phone = normalizePhone(result.phone);
      if (phone && CALLING && lead.assistantId && !lead.demoCalled) {
        try {
          await placeDemoCall(lead.assistantId, phone, lead.company);
          lead.demoCalled = true;
          lead.phone = phone;
          status.calls++;
          actions.push(`📞 Demo call placed to ${phone}`);
        } catch (e) {
          actions.push(`⚠️ Call failed: ${e.message.slice(0, 100)}`);
        }
      }

      // 3) send the email reply
      let actionLine;
      if (result.should_reply && result.reply) {
        if (AUTO) {
          await sendReply(email, result.reply);
          actionLine = "✅ AI reply sent";
        } else {
          actionLine = "📝 Draft ready (AUTO_SEND off)";
        }
      } else {
        actionLine = "⏭️ No reply (" + result.intent + ")";
      }

      if (hot || result.should_reply) {
        const flag = hot ? "🔥 INTERESTED LEAD" : "📩 New reply";
        await telegram(
          `${flag}\n\n` +
            `<b>${escapeHtml(fromName)}</b> — ${escapeHtml(lead.company || "")}\n` +
            `${escapeHtml(leadEmail)}\n\n` +
            `<b>They said:</b> ${escapeHtml(result.summary)}\n` +
            `<b>Intent:</b> ${result.intent}\n` +
            `<b>${actionLine}</b>\n` +
            (actions.length ? actions.map((a) => "• " + escapeHtml(a)).join("\n") + "\n" : "") +
            (result.reply ? `\n<b>Reply:</b>\n${escapeHtml(result.reply)}` : "")
        );
      }
      console.log(`  • ${fromName}: ${result.intent} — ${actionLine} ${actions.join(" | ")}`);
    } catch (err) {
      console.error(`  ! Error on ${fromName}:`, err.message);
      await telegram(
        `⚠️ Unibox AI error on a reply from <b>${escapeHtml(fromName)}</b>:\n${escapeHtml(err.message)}\n\nHandle this one manually.`
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

function guessCompany(emailAddr) {
  // fallback: turn "owner@elite-roofs.com" -> "Elite Roofs"
  const domain = (emailAddr.split("@")[1] || "").split(".")[0] || "";
  return domain
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Runner ----------------------------------------------------------------
async function main() {
  const once = process.argv.includes("--once");

  if (process.env.PORT) {
    createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "vocalroi-unibox-ai", ...status }, null, 2));
    }).listen(process.env.PORT, () => console.log(`Health endpoint on :${process.env.PORT}`));
  }

  console.log(
    `VocalROI Unibox AI — model=${OPENROUTER_MODEL}, AUTO_SEND=${AUTO}, AUTO_CALL=${CALLING}, every ${POLL_INTERVAL_MINUTES} min${
      once ? " (single run)" : ""
    }`
  );

  if (!existsSync(STATE_FILE)) {
    const data = await instantly("/emails?email_type=received&limit=50");
    const ids = (data.items || []).map((e) => e.id);
    saveState({ processed: ids, leads: {} });
    console.log(`Primed: marked ${ids.length} existing replies as already-seen.`);
    await telegram(
      "🤖 VocalROI Unibox AI is live" +
        (CALLING ? " with Vapi auto-demo 📞" : "") +
        ". I'll alert you the moment an interested lead replies."
    );
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
