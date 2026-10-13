import { db } from "../config/firebase.js";
import { sendTelegramMessage, sendTelegramMedia } from "../integrations/TelegramClient.js";
import { downloadWhatsAppMedia } from "../integrations/WhatsAppCloud.js";

/**
 * Telegram as Reem's WhatsApp inbox for Saad's number.
 *
 * Every customer message (text, voice note, photo, file) is mirrored to her
 * Telegram chat, and Saad's reply is posted as a Telegram *reply* to it, so
 * each conversation reads as a thread. Each mirrored Telegram message id is
 * mapped to the customer's phone (Firestore `waInbox`), so when Reem swipes
 * to reply to any of them, src/telegram/bot.js knows which customer to send
 * her text to — no /reply command or number needed.
 */

const MEDIA_KIND = { image: "photo", sticker: "photo", audio: "voice", video: "video", document: "document" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "video/mp4": "mp4", "application/pdf": "pdf" };

export async function linkTelegramMessage(tgMessageId, phone, name, { question = null, saadReply = null } = {}) {
  if (!tgMessageId) return;
  await db.collection("waInbox").doc(String(tgMessageId)).set({ phone, name: name || null, question, saadReply, at: new Date() });
}

export async function phoneForTelegramMessage(tgMessageId) {
  if (!tgMessageId) return null;
  const doc = await db.collection("waInbox").doc(String(tgMessageId)).get();
  return doc.exists ? doc.data() : null;
}

/** Mirrors one incoming customer message. Returns the Telegram message id (thread root). */
export async function mirrorCustomerMessage(msg, { humanMode = false } = {}) {
  const tags = [msg.productName ? `📦 ${msg.productName}` : null, msg.referral ? `📣 إعلان${msg.referral.headline ? `: ${msg.referral.headline.slice(0, 40)}` : ""}` : null].filter(Boolean);
  const header = `${humanMode ? "👤 (محادثتك) " : "💬 "}${msg.name || "زبون"} · +${msg.from}${tags.length ? `\n${tags.join(" · ")}` : ""}`;
  let tgId = null;

  if (msg.mediaId) {
    try {
      const { buffer, mimeType } = await downloadWhatsAppMedia(msg.mediaId);
      const kind = msg.type === "audio" && !msg.voice ? "audio" : MEDIA_KIND[msg.type] || "document";
      const filename = msg.filename || `${msg.type}-${Date.now()}.${EXT[mimeType.split(";")[0]] || "bin"}`;
      tgId = await sendTelegramMedia(kind, buffer, { filename, mimeType, caption: `${header}${msg.text ? `\n${msg.text}` : ""}` });
    } catch (error) {
      console.error("⚠️ Couldn't mirror WhatsApp media:", error.message);
    }
  }
  if (!tgId) {
    const body = msg.text || (msg.mediaId ? `[${msg.type} — ما قدرت أجيبه]` : `[${msg.type}]`);
    tgId = await sendTelegramMessage(`${header}\n${body}`);
  }
  await linkTelegramMessage(tgId, msg.from, msg.name, { question: msg.text || null });
  return tgId;
}

/** Posts Saad's (or the team's) reply under the customer's message. */
export async function mirrorReply(phone, text, { threadId = null, escalated = false, reason = null, failed = null, question = null } = {}) {
  let out = `🤖 سعد: ${text}`;
  if (failed) out = `❌ سعد ما قدر يبعت الرد (${failed}):\n${text}`;
  if (escalated) out += `\n\n🙋 محوّلة إلك${reason ? ` — ${reason}` : ""}\nاسحبي رسالة الزبون لليمين واكتبي ردك.`;
  else out += `\n(تعليم سعد: اسحبي هالرد واكتبي «علّم: الرد الأفضل»)`;
  const tgId = await sendTelegramMessage(out, undefined, { replyTo: threadId });
  await linkTelegramMessage(tgId, phone, null, { question, saadReply: text });
  return tgId;
}
