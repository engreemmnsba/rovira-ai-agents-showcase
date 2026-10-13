/**
 * WhatsApp Cloud API client for "سعد" — Rovira's customer-facing number
 * (number configured in .env). Separate credentials from WhatsAppClient.js, which only
 * sends Reem her own approval alerts:
 *
 *   SAAD_WA_TOKEN          permanent System User token (WhatsApp messaging)
 *   SAAD_PHONE_NUMBER_ID   the Cloud API phone-number id of Saad's number
 *
 * Only two things here: send a text reply inside an open customer
 * conversation, and mark an incoming message as read. Nothing here can
 * start a conversation with someone who didn't message first — WhatsApp
 * itself only allows free-form replies inside the 24h window the customer
 * opened, and this file has no template-message (cold outreach) function.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

function creds() {
  const token = process.env.SAAD_WA_TOKEN;
  const phoneNumberId = process.env.SAAD_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("SAAD_WA_TOKEN / SAAD_PHONE_NUMBER_ID are not set in .env — see docs/WHATSAPP_SAAD.md.");
  }
  return { token, phoneNumberId };
}

async function post(body) {
  const { token, phoneNumberId } = creds();
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `WhatsApp API HTTP ${res.status}`);
  }
  return data;
}

/** Replies with plain text to a customer who messaged first. Returns the message id. */
export async function sendWhatsAppText(to, text) {
  const data = await post({ to, type: "text", text: { body: String(text).slice(0, 4000), preview_url: false } });
  return data.messages?.[0]?.id || null;
}

/** Blue ticks on the customer's message. Never throws — cosmetic only. */
export async function markWhatsAppRead(messageId) {
  try {
    await post({ status: "read", message_id: messageId });
  } catch (error) {
    console.error("⚠️  Couldn't mark WhatsApp message as read:", error.message);
  }
}

/**
 * Downloads a customer's voice note / photo / file so it can be shown to
 * Reem on Telegram. Two calls: media id → short-lived URL, then the bytes
 * (the URL itself also needs the token). Returns { buffer, mimeType }.
 */
export async function downloadWhatsAppMedia(mediaId) {
  const { token } = creds();
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) throw new Error(meta?.error?.message || `WhatsApp media lookup HTTP ${metaRes.status}`);
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`WhatsApp media download HTTP ${fileRes.status}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type || "application/octet-stream" };
}
