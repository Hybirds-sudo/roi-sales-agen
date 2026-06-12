// Dry-run tester: runs sample lead messages through the REAL agent brain.
// Shows the decision + the reply it would send. Does NOT send emails or place calls.
// At the end it actually builds (then deletes) a Vapi demo agent to prove creation works.
import { classifyAndDraft, createDemoAssistant, vapi } from "./unibox-ai.js";

const scenarios = [
  {
    name: "Mike", email: "mike@apexroofing.com", subject: "Re: missed calls at Apex Roofing?",
    text: "Yeah this actually sounds interesting. How does it even work though?",
  },
  {
    name: "Dana", email: "dana@flowproplumbing.com", subject: "Re: quick question Dana",
    text: "How much does something like this cost per month?",
  },
  {
    name: "Carlos", email: "carlos@summithvac.com", subject: "Re: missed calls?",
    text: "Honestly just show me. Call my cell (555) 123-4567 and let me hear it.",
  },
  {
    name: "Brad", email: "brad@bradsroofing.com", subject: "Re: ...",
    text: "We already have a girl answering the phones, not interested.",
  },
];

for (const s of scenarios) {
  const email = {
    from_address_json: [{ name: s.name }],
    from_address_email: s.email,
    subject: s.subject,
    body: { text: s.text },
  };
  console.log("\n============================================================");
  console.log(`LEAD (${s.name}): "${s.text}"`);
  console.log("------------------------------------------------------------");
  try {
    const r = await classifyAndDraft(email);
    console.log(`stage:      ${r.stage}`);
    console.log(`wants_demo: ${r.wants_demo}`);
    console.log(`phone:      ${r.phone || "(none)"}`);
    console.log(`summary:    ${r.summary}`);
    console.log(`\nAI REPLY:\n${r.reply || "(no reply — " + r.stage + ")"}`);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

console.log("\n============================================================");
console.log("Proving demo-agent creation (Vapi)...");
try {
  const id = await createDemoAssistant("Apex Roofing", "roofing", "Mike");
  console.log(`✅ Built a branded Vapi agent: ${id}`);
  await vapi(`/assistant/${id}`, { method: "DELETE" });
  console.log("🧹 (test agent deleted)");
} catch (e) {
  console.log("Vapi error:", e.message);
}
console.log("\nDone.");
