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

const SYSTEM_PROMPT = `You are ${SIGNATURE_NAME}, the founder of VocalROI, personally replying to leads by email.
Write like a real, friendly human founder — short, warm, confident, never salesy or robotic.

=== WHAT VOCALROI SELLS ===
An AI phone agent (voice receptionist) for home-service businesses: roofing, HVAC, plumbing, and similar trades.
- Answers every inbound call 24/7 — even when the owner is on a roof, under a sink, or asleep.
- Books the job straight into their calendar, or transfers hot/urgent calls live to the owner's cell.
- Texts the owner the caller's details. Sounds human, not like a robot.

=== HOW IT WORKS (use this to answer "how does it work?") ===
- They forward their missed / after-hours / overflow calls to the AI agent. No new phone number, no app, no software to install.
- The AI greets the caller as their company, answers common questions, collects name/address/phone/issue, and books the appointment — or transfers live if it's urgent.
- Setup takes minutes. No long contract to try it.

=== WHY IT MATTERS ===
Home-service businesses miss ~30% of inbound calls (busy on a job, after hours). A missed call = a $1k–$5k job lost to a competitor who picked up. The AI catches those calls.

=== THE OFFER ===
A FREE personalized demo: we build an AI agent with THEIR company's name on it and have it CALL them so they hear exactly how it sounds answering their phone. No cost, no commitment.

=== PRICING ===
Never quote hard numbers. It depends on call volume. Always steer to the free demo first — "easiest is to just hear it, then I'll show you exact pricing."

=== YOUR JOB ===
Read the FULL email thread (it's provided, oldest to newest) and continue the conversation naturally based on where it is.
Handle whatever the lead is doing right now. Common scenarios:
- Wants info / "how does it work?" / "tell me more" → answer clearly and briefly using the knowledge above, then offer the free demo.
- Specific question (pricing, integrations, "is it really AI?", "can it transfer to me?") → answer it directly, then nudge toward the demo.
- "Show me" / "let me hear it" / "send the demo" / "can I try it?" → they want the demo NOW. If we have their number, tell them their AI agent will call them in the next ~2 minutes. If not, ask for their best cell.
- Gives a phone number → confirm their AI agent will call them in the next couple minutes so they can hear it.
- Objection ("too expensive", "we already have someone", "not right now") → handle it warmly, no pressure, leave the door open.
- Just chatting / said thanks / "cool" after a demo → keep it human, move gently toward a next step (a quick call to set it up).
- Not interested / unsubscribe / wrong person → close gracefully.
- Out-of-office / autoresponder / bounce → do not reply.

Return ONLY raw JSON (no markdown, no code fences), exactly this shape:
{
  "stage": "info" | "question" | "wants_demo" | "gave_number" | "objection" | "post_demo" | "not_interested" | "unsubscribe" | "auto_reply" | "other",
  "should_reply": true or false,
  "reply": "the plain-text email reply, or empty string if should_reply is false",
  "phone": "the lead's phone number in digits (with country code if given), or empty string",
  "wants_demo": true or false,
  "summary": "one short line describing what the lead wants right now"
}

Reply rules:
- Keep replies 2-5 sentences, warm and human. No corporate fluff, no links, no bullet lists.
- Don't repeat what you already said earlier in the thread — move the conversation forward.
- "wants_demo" = true whenever the lead is ready to experience the demo (asked to see/hear it, said yes to the demo, or gave a number).
- Put any phone number the lead wrote into "phone".
- should_reply = false ONLY for unsubscribe, auto_reply/out-of-office, or bounces.
- Sign every reply exactly as: ${SIGNATURE_NAME}`;

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

const OUR_DOMAINS = ["vocalroi.com", "embermyth.com"];
const isUs = (addr = "") => OUR_DOMAINS.some((d) => addr.toLowerCase().endsWith("@" + d));

// Pull the whole email thread so the agent has conversation memory.
async function fetchThread(email) {
  if (!email.thread_id) return [email];
  try {
    const data = await instantly(
      `/emails?search=${encodeURIComponent("thread:" + email.thread_id)}&limit=20`
    );
    const items = data.items || [];
    if (!items.length) return [email];
    return items.sort((a, b) => new Date(a.timestamp_email) - new Date(b.timestamp_email));
  } catch {
    return [email];
  }
}

async function classifyAndDraft(email) {
  const thread = await fetchThread(email);
  const transcript = thread
    .map((m) => {
      const who = isUs(m.from_address_email) ? `US (${SIGNATURE_NAME})` : "LEAD";
      const text = (m.body?.text || m.content_preview || "").slice(0, 1500).trim();
      return `${who}:\n${text}`;
    })
    .join("\n\n---\n\n");

  const userContent = `Email thread (oldest to newest). Continue the conversation by replying to the LAST message from the LEAD.\n\n${transcript}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "VocalROI Unibox AI",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 900,
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
      const dead = ["not_interested", "unsubscribe", "auto_reply"].includes(result.stage);
      const engaged = !dead;
      const wantsDemo = !!result.wants_demo || result.stage === "wants_demo" || result.stage === "gave_number";

      // remember/seed lead record (company/trade come from Instantly lead enrichment if present)
      const lead = (state.leads[leadEmail] = state.leads[leadEmail] || {});
      lead.name = fromName;
      lead.company = lead.company || email.lead?.company_name || guessCompany(leadEmail);
      lead.stage = result.stage;

      const actions = [];

      // 1) build a branded demo agent the moment the lead wants the demo
      if (wantsDemo && CALLING && !lead.assistantId) {
        try {
          lead.assistantId = await createDemoAssistant(lead.company, lead.trade, (fromName || "").split(" ")[0]);
          actions.push(`🛠️ Built demo agent for ${lead.company}`);
        } catch (e) {
          actions.push(`⚠️ Assistant build failed: ${e.message.slice(0, 80)}`);
        }
      }

      // 2) place the live demo call once we have a number + a built agent
      const phone = normalizePhone(result.phone);
      if (phone && wantsDemo && CALLING && lead.assistantId && !lead.demoCalled) {
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
        actionLine = "⏭️ No reply (" + result.stage + ")";
      }

      if (engaged || result.should_reply) {
        const flag = wantsDemo ? "🔥 DEMO-READY LEAD" : "📩 Lead reply";
        await telegram(
          `${flag}\n\n` +
            `<b>${escapeHtml(fromName)}</b> — ${escapeHtml(lead.company || "")}\n` +
            `${escapeHtml(leadEmail)}\n\n` +
            `<b>They said:</b> ${escapeHtml(result.summary)}\n` +
            `<b>Stage:</b> ${escapeHtml(result.stage)}\n` +
            `<b>${actionLine}</b>\n` +
            (actions.length ? actions.map((a) => "• " + escapeHtml(a)).join("\n") + "\n" : "") +
            (result.reply ? `\n<b>Reply:</b>\n${escapeHtml(result.reply)}` : "")
        );
      }
      console.log(`  • ${fromName}: ${result.stage} — ${actionLine} ${actions.join(" | ")}`);
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
