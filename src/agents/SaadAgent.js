import Anthropic from "@anthropic-ai/sdk";
import { db } from "../config/firebase.js";
import { logAudit } from "../core/AuditLog.js";
import { isScopedAutonomous } from "../core/Permissions.js";
import { getSaadTrainingBlock, addSaadExample } from "../core/SaadTraining.js";
import { getSalesCatalog, detectProduct, allowedNumbers, formatCatalog, giveTrialCode } from "../core/ProductSales.js";
import { getBrandIdentity } from "../core/BrandKit.js";
import { getCompanyProfile } from "../core/CompanyKnowledge.js";
import { sendWhatsAppText, markWhatsAppRead } from "../integrations/WhatsAppCloud.js";
import { mirrorCustomerMessage, mirrorReply } from "../whatsapp/TelegramInbox.js";
import { handleLeadFlow } from "../whatsapp/LeadFlow.js";
import { sendTelegramMessage } from "../integrations/TelegramClient.js";
import { appendSheetRow } from "../integrations/SheetsClient.js";

/**
 * "سعد" — Rovira's customer-facing WhatsApp agent.
 *
 * This is the ONE standing exception Reem approved (2026-10-07) to the
 * "no external action without my approval" rule — see
 * SCOPED_AUTONOMOUS_ACTIONS in Permissions.js. Its limits are enforced here:
 *  - answers ONLY from the product sheets + company profile + brand identity
 *  - never gives prices, dates/timelines, discounts, or promises
 *  - never mentions Reem by name — escalations are "حدا من الفريق رح يرد عليك"
 *  - anything it can't answer from those sources → escalates to Reem on
 *    Telegram and stops guessing
 *  - once Reem replies herself (swipe-reply or /reply), the chat switches to human mode
 *    for HUMAN_MODE_HOURS: Saad stays silent and only forwards messages
 *  - it can only REPLY to someone who messaged first (WhatsApp's 24h
 *    customer-service window); there is no outbound/broadcast path at all
 *
 * Every incoming message and every reply is logged to Firestore
 * (whatsappConversations), to Reem's Google Sheet, and mirrored to her
 * Telegram as an inbox (src/whatsapp/TelegramInbox.js) — she replies by
 * swiping to reply to any mirrored message.
 */

const HUMAN_MODE_HOURS = 12;
const TYPE_AR = { audio: "فويس", image: "صورة", video: "فيديو", document: "ملف", sticker: "ستيكر", location: "موقع", contacts: "جهة اتصال" };
const HISTORY_LIMIT = 12;
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const HARD_RULES = `قواعد صارمة ما فيها استثناء:
1. جاوب بس من "التطبيقات" و"ملف الشركة" و"الهوية" تحت. إذا المعلومة مش موجودة فيهم، لا تخمّن ولا تألّف — حوّل للفريق.
2. الأسعار: مسموح تذكر بس أسعار الباقات المكتوبة تحت كل تطبيق، حرفيًا بنفس الرقم والعملة. ممنوع: أي سعر لمشروع مفصّل أو أتمتة أو AI Agent، أي خصم أو عرض مش مكتوب، أي مدة تنفيذ أو موعد تسليم، أي وعد أو التزام. إذا سأل عن شي من هدول: بيعتمد على التفاصيل وحدا من الفريق رح يتواصل معه — وحوّل.
3. أكواد التجربة: ما تكتب أي كود بإيدك أبدًا. إذا الزبون جاهز يجرب تطبيق، حط slug التطبيق بـ "trialFor" والنظام بيضيف الكود للرد لحاله. اكتب الرد كأنه الكود جاي بآخره (متل: "هاد كود التجربة تبعك:").
4. ما تذكر أي اسم شخص من الفريق. لما تحوّل قول: "حدا من الفريق رح يرد عليك بأقرب وقت".
5. أنت سعد من روفيرا. أول رد بمحادثة جديدة يبدأ بـ "معك سعد، تفضل". بعدها لا تكرر التعريف.
6. ردود قصيرة (١-٤ جمل)، لهجة شامية واضحة ومحترمة، بدون إيموجي كتير. إذا الزبون كتب إنجليزي، جاوب إنجليزي.
7. طريقة البيع لما الزبون مهتم بتطبيق: افهم شغله ومشكلته بسؤال واحد ← وصّل الفايدة اللي بتحل مشكلته هو (مش لائحة ميزات) ← ابعت رابط التنزيل المناسب لجهازه ← اعرض التجربة المجانية ← رد على اعتراضاته بهدوء من المعلومات المتاحة. لا تضغط ولا تبالغ.
8. ما تطلب معلومات حساسة (كلمات سر، بيانات بنكية، أرقام هوية) أبدًا.
9. حوّل فورًا إذا: الزبون جاهز يدفع أو يشترك، طلب يحكي مع إنسان، زعلان أو عنده شكوى، أو بده مشروع مفصّل.`;

export default class SaadAgent {
  constructor() {
    this.id = "whatsapp-support";
    this.name = "Saad (WhatsApp customer agent)";
  }

  /** Entry point from the webhook. `msg` = { from, name, type, text, messageId, timestamp } */
  async handleIncoming(msg) {
    const convRef = db.collection("whatsappConversations").doc(msg.from);
    const convDoc = await convRef.get();
    const conv = convDoc.exists ? convDoc.data() : null;
    const isNew = !conv;

    // Which app is this about? A Click-to-WhatsApp ad (referral) or the
    // message itself decides; once known it sticks to the conversation.
    const catalog = await getSalesCatalog();
    const detected = detectProduct(catalog, { referral: msg.referral, text: msg.text });
    const product = detected || conv?.product || null;
    msg.product = product;
    msg.productName = catalog.find(p => p.slug === product)?.app || null;

    await convRef.set(
      {
        phone: msg.from,
        name: msg.name || conv?.name || null,
        lastMessageAt: new Date(),
        createdAt: conv?.createdAt || new Date(),
        humanModeUntil: conv?.humanModeUntil || null,
        messageCount: (conv?.messageCount || 0) + 1,
        product,
        ...(msg.referral ? { lastAd: { id: msg.referral.source_id || null, headline: msg.referral.headline || null, url: msg.referral.source_url || null, at: new Date() } } : {})
      },
      { merge: true }
    );
    await convRef.collection("messages").add({ role: "customer", type: msg.type, text: msg.text || null, waMessageId: msg.messageId, at: new Date() });
    await markWhatsAppRead(msg.messageId);

    // Every message lands in Reem's Telegram (text, voice, photo, file) —
    // that's her inbox for this number. Saad's reply is threaded under it.
    const humanMode = this.inHumanMode(conv);
    const threadId = await mirrorCustomerMessage(msg, { humanMode });

    // Reem took over this chat recently — stay silent; she sees it above.
    if (humanMode) {
      await this.logToSheet({ name: msg.name, phone: msg.from, question: msg.text || `[${msg.type}]`, answer: "(بانتظار رد الفريق)", status: "مع الفريق" });
      return;
    }

    // Website lead flow ("عندي فكرة مشروع" → 3 scripted questions → Reem).
    const handledByLeadFlow = await handleLeadFlow({
      msg,
      conv,
      send: (text, { topic = "طلب مشروع", reason = null } = {}) =>
        this.reply(msg.from, text, { escalated: false, reason, question: msg.text || `[${msg.type}]`, name: msg.name, topic, threadId }),
      logToSheet: row => this.logToSheet(row),
      setHumanMode: () =>
        db.collection("whatsappConversations").doc(msg.from).set({ humanModeUntil: new Date(Date.now() + HUMAN_MODE_HOURS * 3600 * 1000) }, { merge: true })
    });
    if (handledByLeadFlow) return;

    // Voice note / photo with no text — Saad can't read it; Reem can (it's
    // in Telegram above). Ask the customer for text and hand it to Reem.
    if (!msg.text) {
      await this.reply(msg.from, "تسلم! بتقدر تكتبلي سؤالك كتابة عشان أقدر أساعدك؟", {
        escalated: true, reason: `بعت ${TYPE_AR[msg.type] || msg.type}`, question: `[${msg.type}]`, name: msg.name, threadId
      });
      return;
    }

    const decision = await this.draftReply(msg, isNew);
    await this.reply(msg.from, decision.reply, {
      escalated: decision.escalate,
      reason: [decision.reason, decision.trialCode ? `أعطى كود ${decision.trialCode}` : null].filter(Boolean).join(" · ") || null,
      question: msg.text, name: msg.name, topic: decision.topic, threadId
    });
  }

  inHumanMode(conv) {
    const until = conv?.humanModeUntil?.toDate ? conv.humanModeUntil.toDate() : conv?.humanModeUntil;
    return Boolean(until && new Date(until) > new Date());
  }

  async loadHistory(phone) {
    const snap = await db.collection("whatsappConversations").doc(phone).collection("messages").orderBy("at", "desc").limit(HISTORY_LIMIT).get();
    return snap.docs.map(d => d.data()).reverse();
  }

  async draftReply(msg, isNew) {
    const [identity, catalog, companyProfile, history, training] = await Promise.all([
      getBrandIdentity(),
      getSalesCatalog(),
      getCompanyProfile(),
      this.loadHistory(msg.from),
      getSaadTrainingBlock()
    ]);

    const knowledge = [
      `الهوية:\n${identity}`,
      companyProfile ? `ملف الشركة:\n${companyProfile}` : "ملف الشركة: (فاضي)",
      catalog.length ? `التطبيقات:\n${formatCatalog(catalog, msg.product)}` : "التطبيقات: (فاضية — أي سؤال عن تفاصيل تطبيق لازم يتحوّل للفريق)",
      training || ""
    ].filter(Boolean).join("\n\n");

    const system = `${HARD_RULES}

${isNew ? "هاي أول رسالة من هالزبون." : "محادثة مستمرة — لا تعيد التعريف بنفسك."}
${msg.referral ? `الزبون جاي من إعلان: «${[msg.referral.headline, msg.referral.body].filter(Boolean).join(" — ").slice(0, 300)}».` : ""}
${msg.productName ? `الزبون مهتم بـ: ${msg.productName} (slug: ${msg.product}). ركّز عليه.` : "لسا مش واضح أي تطبيق أو خدمة بده — اسأله عن شغله."}

=== المعلومات المسموح تجاوب منها (ولا شي غيرها) ===
${knowledge}
=== نهاية المعلومات ===

رجّع JSON بس، بدون أي نص قبله أو بعده:
{"reply": "نص الرد للزبون", "escalate": true|false, "reason": "ليش حوّلت (إذا حوّلت)", "topic": "التطبيق أو الخدمة اللي بيسأل عنها، أو عام", "trialFor": "slug التطبيق إذا لازم نعطيه كود تجربة هلق، وإلا null"}`;

    // The current message is already the last item of history (logged above).
    const messages = history
      .filter(h => h.text)
      .map(h => ({ role: h.role === "customer" ? "user" : "assistant", content: h.text }));
    const merged = [];
    for (const m of messages) {
      if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += `\n${m.content}`;
      else merged.push({ ...m });
    }
    if (!merged.length || merged[0].role !== "user") merged.unshift({ role: "user", content: msg.text });

    try {
      const res = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
        max_tokens: 500,
        system,
        messages: merged
      });
      const raw = res.content.find(b => b.type === "text")?.text?.trim() || "{}";
      const parsed = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]);
      if (!parsed.reply) throw new Error("empty reply");
      // Hard guard in code, not just in the prompt: any number that looks
      // like a price or a duration must be one Reem published (packages /
      // trial days); anything else — or a discount — is NEVER sent.
      const violation = pricingViolation(parsed.reply, allowedNumbers(catalog));
      if (violation) {
        return {
          reply: "بخصوص التكلفة والتفاصيل، حدا من الفريق رح يتواصل معك بأقرب وقت ويوضحلك كل شي.",
          escalate: true,
          reason: `مسودة سعد فيها ${violation} مش من الأسعار المعتمدة فانمنعت: «${parsed.reply.slice(0, 120)}»`,
          topic: parsed.topic || msg.productName || "عام"
        };
      }

      let reply = parsed.reply;
      let escalate = Boolean(parsed.escalate);
      let reason = parsed.reason || null;
      let trialCode = null;
      const trialSlug = parsed.trialFor && catalog.some(p => p.slug === parsed.trialFor) ? parsed.trialFor : null;
      if (trialSlug) {
        const given = await giveTrialCode(trialSlug, msg.from);
        if (given) {
          trialCode = given.code;
          if (!given.reused && given.remaining <= 3) {
            await sendTelegramMessage(`⚠️ أكواد تجربة ${trialSlug} قرّبت تخلص — باقي ${given.remaining}. ابعتيلي أكواد جديدة.`);
          }
          reply = `${reply}\n\n🎟 ${given.code}`;
        } else {
          reply = `${reply}\n\nكود التجربة رح يوصلك من الفريق خلال وقت قصير.`;
          escalate = true;
          reason = `خلصت أكواد التجربة لـ ${trialSlug} — الزبون مستني كود`;
        }
      }
      return { reply, escalate, reason, topic: parsed.topic || msg.productName || "عام", trialCode };
    } catch (error) {
      console.error("❌ Saad draft failed:", error.message);
      return {
        reply: isNew ? "معك سعد، تفضل. وصلت رسالتك، وحدا من الفريق رح يرد عليك بأقرب وقت." : "وصلت رسالتك، وحدا من الفريق رح يرد عليك بأقرب وقت.",
        escalate: true,
        reason: `خطأ تقني بسعد: ${error.message}`,
        topic: "عام"
      };
    }
  }

  /** Sends + logs one reply from Saad. */
  async reply(to, text, { escalated = false, reason = null, question = "", name = null, topic = "عام", threadId = null } = {}) {
    let waId = null;
    let error = null;
    // The single call site of Saad's scoped exception — refuses if it was
    // ever removed from Permissions.js.
    if (!isScopedAutonomous(this.id, "REPLY_FROM_KNOWLEDGE")) {
      throw new Error(`${this.id} is not allowed to auto-reply (REPLY_FROM_KNOWLEDGE not in SCOPED_AUTONOMOUS_ACTIONS).`);
    }
    try {
      waId = await sendWhatsAppText(to, text);
    } catch (e) {
      error = e.message;
    }
    await mirrorReply(to, text, { threadId, escalated, reason, failed: error, question });
    await db.collection("whatsappConversations").doc(to).collection("messages").add({ role: "saad", text, waMessageId: waId, escalated, reason, error, at: new Date() });
    await logAudit({
      actorType: "agent",
      agentId: this.id,
      action: "WHATSAPP_AUTO_REPLY",
      status: error ? "FAILED" : "EXECUTED",
      details: `${escalated ? "[escalated] " : ""}to +${to}: ${text.slice(0, 200)}${error ? ` — error: ${error}` : ""}`
    });
    await this.logToSheet({ name, phone: to, question, answer: text, status: escalated ? "محوّل للفريق" : "رد سعد", topic, note: reason });
  }

  async logToSheet({ name, phone, question, answer, status, topic = "", note = "" }) {
    const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Hebron" });
    return appendSheetRow([when, name || "", `+${phone}`, question || "", answer || "", status || "", topic || "", note || ""]);
  }
}

const DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const PRICE_OR_TIME = /(\$|دولار|شيكل|شيقل|₪|دينار|ريال|درهم|يورو|€|usd|aed|sar|ils|jod|سعر|تكلف|يوم|أيام|ايام|اسبوع|أسبوع|أسابيع|شهر|أشهر|شهور|سنة|سنوي|ساعة|ساعات|day|week|month|year|hour)/i;

/**
 * Returns a short description of what's wrong, or null if the reply is OK.
 * Every number sitting next to a currency / price / time word must be in
 * the published list (package prices, package periods, trial days).
 */
function pricingViolation(text = "", allowed = new Set()) {
  const t = String(text).replace(/[٠-٩]/g, d => DIGITS[d]);
  if (/(خصم|تخفيض|discount|عرض خاص)/i.test(t)) return "خصم/عرض";
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[0].replace(",", "."));
    const around = t.slice(Math.max(0, m.index - 14), m.index + m[0].length + 14);
    if (PRICE_OR_TIME.test(around) && !allowed.has(n)) return `رقم (${m[0]})`;
  }
  return null;
}

/** Reem's own reply from Telegram (/reply). Switches the chat to human mode. */
export async function replyAsTeam(phone, text) {
  const to = String(phone).replace(/[^\d]/g, "");
  const waId = await sendWhatsAppText(to, text);
  const convRef = db.collection("whatsappConversations").doc(to);
  // Saad learns Reem's style from her real replies (SaadTraining.js).
  const lastCustomer = (await convRef.collection("messages").orderBy("at", "desc").limit(10).get()).docs
    .map(d => d.data())
    .find(m => m.role === "customer" && m.text);
  await addSaadExample(lastCustomer?.text || "", text);
  await convRef.set({ humanModeUntil: new Date(Date.now() + HUMAN_MODE_HOURS * 3600 * 1000) }, { merge: true });
  await convRef.collection("messages").add({ role: "team", text, waMessageId: waId, at: new Date() });
  await logAudit({ actorType: "user", agentId: "whatsapp-support", action: "WHATSAPP_TEAM_REPLY", status: "EXECUTED", details: `to +${to}: ${text.slice(0, 200)}` });
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Hebron" });
  await appendSheetRow([when, "", `+${to}`, "", text, "رد الفريق", "", ""]);
  return { ok: true, to, humanModeHours: HUMAN_MODE_HOURS };
}

/** Hands a chat back to Saad before the human-mode window ends (/saad). */
export async function handBackToSaad(phone) {
  const to = String(phone).replace(/[^\d]/g, "");
  await db.collection("whatsappConversations").doc(to).set({ humanModeUntil: null }, { merge: true });
  return { ok: true, to };
}

export async function listRecentConversations(limit = 10) {
  const snap = await db.collection("whatsappConversations").orderBy("lastMessageAt", "desc").limit(limit).get();
  return snap.docs.map(d => {
    const c = d.data();
    return { phone: c.phone, name: c.name, lastMessageAt: c.lastMessageAt?.toDate?.()?.toISOString?.() ?? null, messageCount: c.messageCount, humanMode: Boolean(c.humanModeUntil && (c.humanModeUntil.toDate ? c.humanModeUntil.toDate() : new Date(c.humanModeUntil)) > new Date()) };
  });
}
