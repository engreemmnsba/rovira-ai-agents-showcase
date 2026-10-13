/**
 * Stage 1 of the WhatsApp integration: outbound alerts only. When an agent
 * creates a WAITING_APPROVAL request, ApprovalGate.js calls this to also
 * push the same summary to Reem's WhatsApp — nothing here can approve,
 * reject, or execute anything. She still decides from the terminal
 * (node src/approve.js / src/reject.js) or by telling Claude, exactly as
 * before; this only adds a second place she finds out about it. See
 * docs/WHATSAPP_SETUP.md.
 *
 * Uses Meta's WhatsApp Cloud API directly (no Twilio) — Twilio's own
 * account-verification SMS/voice call can't reliably reach Palestinian
 * numbers (confirmed while setting this up), so this goes straight to the
 * source instead. Delivery to Reem's number is via the app's test/dev mode
 * (free, no business verification needed for a single fixed recipient).
 *
 * If it isn't configured yet, this quietly no-ops — the approval still
 * gets created and printed to the console either way, so nothing is ever
 * blocked on WhatsApp being set up.
 */

const GRAPH_API_VERSION = "v21.0";

export async function sendWhatsAppAlert(message) {
  const { META_WHATSAPP_TOKEN, META_PHONE_NUMBER_ID, WHATSAPP_ALERT_NUMBER } = process.env;

  if (!META_WHATSAPP_TOKEN || !META_PHONE_NUMBER_ID || !WHATSAPP_ALERT_NUMBER) {
    console.log("ℹ️  WhatsApp alerts not configured yet (see docs/WHATSAPP_SETUP.md) — skipping, nothing else affected.");
    return null;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: WHATSAPP_ALERT_NUMBER,
          type: "text",
          text: { body: message }
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      // The dev-mode access token expires (~24h) or the number list can
      // change — either way, this is the same "recoverable, not fatal"
      // shape as an expired LinkedIn token: log it clearly and move on.
      console.error(
        "⚠️  Couldn't send the WhatsApp alert (approval was still created — check node src/list-approvals.js):",
        data?.error?.message || `HTTP ${res.status}`
      );
      return null;
    }

    return data.messages?.[0]?.id || null;
  } catch (error) {
    console.error("⚠️  Couldn't send the WhatsApp alert (approval was still created — check node src/list-approvals.js):", error.message);
    return null;
  }
}
