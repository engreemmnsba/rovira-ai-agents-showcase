import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../config/firebase.js";
import SaadAgent from "../agents/SaadAgent.js";

/**
 * Public HTTPS endpoint Meta calls for Saad's WhatsApp number. nginx on the
 * droplet terminates TLS for <your-domain> and proxies to this port
 * (docs/WHATSAPP_SAAD.md). Two routes:
 *
 *  GET  /whatsapp/webhook   Meta's one-time verification handshake
 *  POST /whatsapp/webhook   incoming messages — signature-checked with the
 *                           Meta app secret, acknowledged immediately, then
 *                           handled in the background (Meta retries if we're
 *                           slow, so duplicates are dropped by message id)
 *
 * Env: WA_VERIFY_TOKEN (any random string you also paste into Meta),
 *      WA_APP_SECRET (Meta app → App settings → Basic → App secret),
 *      WA_WEBHOOK_PORT (default 3005).
 */

const saad = new SaadAgent();
const PRIVACY_HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "privacy.html"), "utf8");

export function startWhatsAppWebhook() {
  const { WA_VERIFY_TOKEN, WA_APP_SECRET, SAAD_WA_TOKEN } = process.env;
  if (!WA_VERIFY_TOKEN || !WA_APP_SECRET || !SAAD_WA_TOKEN) {
    console.log("ℹ️  Saad (WhatsApp) not configured yet — WA_VERIFY_TOKEN / WA_APP_SECRET / SAAD_WA_TOKEN missing. See docs/WHATSAPP_SAAD.md.");
    return null;
  }

  const app = express();
  // Keep the raw body: the signature is computed over the exact bytes.
  app.use("/whatsapp/webhook", express.raw({ type: "*/*", limit: "1mb" }));

  app.get("/whatsapp/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WA_VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  });

  app.post("/whatsapp/webhook", (req, res) => {
    const signature = req.get("x-hub-signature-256") || "";
    const expected = "sha256=" + crypto.createHmac("sha256", WA_APP_SECRET).update(req.body).digest("hex");
    const valid =
      signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      console.warn("⛔ Rejected a WhatsApp webhook call with a bad signature.");
      return res.sendStatus(401);
    }

    res.sendStatus(200); // ack fast; Meta retries otherwise

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return;
    }
    handlePayload(payload).catch(error => console.error("❌ WhatsApp webhook handling failed:", error.message));
  });

  app.get("/healthz", (_req, res) => res.send("ok"));
  // Public privacy policy (Meta requires one before the app can go Live).
  // nginx only exposes /whatsapp/ → https://<your-domain>/whatsapp/privacy
  app.get("/whatsapp/privacy", (_req, res) => res.type("html").send(PRIVACY_HTML));

  const port = Number(process.env.WA_WEBHOOK_PORT || 3005);
  const server = app.listen(port, "127.0.0.1", () => console.log(`📱 Saad WhatsApp webhook listening on 127.0.0.1:${port}`));
  return server;
}

async function handlePayload(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // Only messages to Saad's own number — ignore anything else on the WABA.
      if (process.env.SAAD_PHONE_NUMBER_ID && value.metadata?.phone_number_id !== process.env.SAAD_PHONE_NUMBER_ID) continue;
      const names = Object.fromEntries((value.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        // De-duplicate Meta retries: create() fails if this id was seen.
        try {
          await db.collection("whatsappSeen").doc(m.id).create({ at: new Date() });
        } catch {
          continue;
        }
        const media = m[m.type] && m[m.type].id ? m[m.type] : null; // image / audio / video / document / sticker
        await saad.handleIncoming({
          from: m.from,
          name: names[m.from] || null,
          type: m.type,
          text:
            m.type === "text" ? m.text?.body
            : m.type === "button" ? m.button?.text
            : m.type === "interactive" ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
            : media?.caption || null,
          mediaId: media?.id || null,
          mimeType: media?.mime_type || null,
          filename: media?.filename || null,
          voice: m.type === "audio" ? Boolean(m.audio?.voice) : false,
          // Click-to-WhatsApp ads: which ad the customer came from.
          referral: m.referral ? { source_id: m.referral.source_id, source_type: m.referral.source_type, source_url: m.referral.source_url, headline: m.referral.headline, body: m.referral.body } : null,
          messageId: m.id,
          timestamp: m.timestamp
        });
      }
    }
  }
}
