/**
* Thin client for the Telegram Bot API — plain HTTPS calls (no SDK), same
* pattern as WhatsAppClient.js. Jobs:
* - sendTelegramMessage: push a message to Reem (alerts + command replies)
* - sendTelegramPhoto: push an image (with an optional caption) to Reem —
*   used by content agents so she sees the actual post, not just text
* - getTelegramUpdates: long-poll for incoming messages (src/telegram/bot.js)
* Nothing here decides anything or executes anything — see docs/TELEGRAM_SETUP.md.
*/

const TELEGRAM_API = "https://api.telegram.org";

function requireToken() {
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
throw new Error(
"TELEGRAM_BOT_TOKEN is not set. Create a bot via @BotFather and add the token to .env — see docs/TELEGRAM_SETUP.md."
);
}
return token;
}

/**
* Long-polls Telegram for new messages since `offset`. Blocks up to 20s
* server-side if there's nothing new (this is normal and expected — call it
* again in a loop, it is not an error or a timeout).
*
* Wrapped in a client-side abort at 25s (5s past the server's own 20s) —
* on a network that silently stalls long-lived HTTPS connections instead of
* cleanly refusing them (common with restrictive/unstable connections),
* plain fetch() would otherwise hang forever with no error and no output.
* The abort turns that into a visible, retriable error instead.
*/
export async function getTelegramUpdates(offset = 0) {
const url = `${TELEGRAM_API}/bot${requireToken()}/getUpdates?offset=${offset}&timeout=20`;
const controller = new AbortController();
const abortTimer = setTimeout(() => controller.abort(), 25000);
try {
const res = await fetch(url, { signal: controller.signal });
const data = await res.json();
if (!data.ok) {
throw new Error(data.description || `Telegram getUpdates failed (HTTP ${res.status})`);
}
return data.result;
} finally {
clearTimeout(abortTimer);
}
}

/**
* Sends a message to `chatId` (defaults to TELEGRAM_CHAT_ID from .env —
* the only chat this whole system will ever willingly talk to). Never
* throws — a failed send is logged and returns null, same shape as
* sendWhatsAppAlert, so nothing upstream ever crashes because a
* notification didn't go out.
*/
export async function sendTelegramMessage(text, chatId = process.env.TELEGRAM_CHAT_ID, { replyTo = null } = {}) {
if (!process.env.TELEGRAM_BOT_TOKEN) {
console.log("ℹ️ Telegram not configured yet (TELEGRAM_BOT_TOKEN missing) — skipping, nothing else affected.");
return null;
}
if (!chatId) {
console.log("ℹ️ TELEGRAM_CHAT_ID not set yet — skipping this message. See docs/TELEGRAM_SETUP.md.");
return null;
}

try {
const res = await fetch(`${TELEGRAM_API}/bot${requireToken()}/sendMessage`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
chat_id: chatId,
text,
...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
})
});
const data = await res.json();
if (!data.ok) {
console.error("⚠️ Couldn't send the Telegram message:", data.description || `HTTP ${res.status}`);
return null;
}
return data.result.message_id;
} catch (error) {
console.error("⚠️ Couldn't send the Telegram message:", error.message);
return null;
}
}

/**
* Sends a photo (by public URL — Telegram fetches it server-side, no file
* upload needed) with an optional caption. Same never-throws contract as
* sendTelegramMessage. Used by content agents (e.g. InstagramContentAgent)
* so Reem sees the real generated image inline, not just a text summary.
*/
export async function sendTelegramPhoto(photoUrl, caption = "", chatId = process.env.TELEGRAM_CHAT_ID) {
if (!process.env.TELEGRAM_BOT_TOKEN) {
console.log("ℹ️ Telegram not configured yet (TELEGRAM_BOT_TOKEN missing) — skipping, nothing else affected.");
return null;
}
if (!chatId) {
console.log("ℹ️ TELEGRAM_CHAT_ID not set yet — skipping this message. See docs/TELEGRAM_SETUP.md.");
return null;
}

try {
const res = await fetch(`${TELEGRAM_API}/bot${requireToken()}/sendPhoto`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption })
});
const data = await res.json();
if (!data.ok) {
console.error("⚠️ Couldn't send the Telegram photo:", data.description || `HTTP ${res.status}`);
return null;
}
return data.result.message_id;
} catch (error) {
console.error("⚠️ Couldn't send the Telegram photo:", error.message);
return null;
}
}

/**
* Downloads a file Reem sent to the bot (a photo or document) as a Buffer.
* Used only to save real app screenshots into the brand asset library —
* the bot never fetches anything else. Telegram's Bot API caps downloads
* at 20 MB, which is plenty for screenshots (short Reels clips: keep them
* under that too).
*/
export async function getTelegramFile(fileId) {
const token = requireToken();
const res = await fetch(`${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
const data = await res.json();
if (!data.ok || !data.result?.file_path) {
throw new Error(data.description || "Telegram getFile failed");
}
const fileRes = await fetch(`${TELEGRAM_API}/file/bot${token}/${data.result.file_path}`);
if (!fileRes.ok) throw new Error(`Telegram file download failed (HTTP ${fileRes.status})`);
return Buffer.from(await fileRes.arrayBuffer());
}

/**
* Uploads a file (Buffer) to Reem's chat — used to mirror customers' voice
* notes, photos and files from Saad's WhatsApp into Telegram. `kind` is the
* Telegram method family: "photo" | "voice" | "audio" | "video" | "document".
* Never throws; returns the Telegram message id or null.
*/
const MEDIA_METHODS = { photo: "sendPhoto", voice: "sendVoice", audio: "sendAudio", video: "sendVideo", document: "sendDocument" };

export async function sendTelegramMedia(kind, buffer, { filename = "file", mimeType = "application/octet-stream", caption = "", replyTo = null, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) return null;
const method = MEDIA_METHODS[kind] || "sendDocument";
const field = MEDIA_METHODS[kind] ? kind : "document";
try {
const form = new FormData();
form.append("chat_id", String(chatId));
if (caption) form.append("caption", caption.slice(0, 1000));
if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
form.append(field, new Blob([buffer], { type: mimeType }), filename);
const res = await fetch(`${TELEGRAM_API}/bot${requireToken()}/${method}`, { method: "POST", body: form });
const data = await res.json();
if (!data.ok) {
console.error(`⚠️ Couldn't send Telegram ${kind}:`, data.description || `HTTP ${res.status}`);
return null;
}
return data.result.message_id;
} catch (error) {
console.error(`⚠️ Couldn't send Telegram ${kind}:`, error.message);
return null;
}
}
