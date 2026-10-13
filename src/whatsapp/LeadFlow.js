import { db } from "../config/firebase.js";
import { sendTelegramMessage } from "../integrations/TelegramClient.js";

/**
 * Website lead flow for Saad — fixed, scripted, no AI.
 *
 * The website's WhatsApp button opens the chat with a ready message
 * ("مرحبا Rovira، عندي فكرة مشروع"). That phrase starts this flow instead
 * of the normal support/sales chat: 3 quick multiple-choice questions
 * (project type → budget → start time), then a hand-off message. Reem gets
 * one Telegram summary the moment the third answer lands, marked 🔥 when
 * the customer wants to start now with a mid/high budget (answer those
 * within the hour). The optional "two lines about the problem" is forwarded
 * too, and the chat is then left to Reem (human mode) — no bot replies on
 * top of her conversation.
 *
 * The wording and budget brackets are Reem's; change them here.
 */

export const LEAD_TRIGGER = /عندي\s+فكرة\s+مشروع|i\s+have\s+a\s+project\s+idea/i;

const STEPS = {
  type: {
    ask: `أهلًا فيك بـ Rovira 👋
رح أسألك 3 أسئلة سريعة عشان نجهزلك أفضل عرض.

شو نوع المشروع؟
1- نظام إدارة / نقاط بيع
2- تطبيق موبايل
3- منصة SaaS
4- أتمتة بالذكاء الاصطناعي
5- غير ذلك`,
    options: [
      { label: "نظام إدارة / نقاط بيع", words: ["نظام", "ادارة", "إدارة", "كاشير", "نقاط بيع", "pos"] },
      { label: "تطبيق موبايل", words: ["تطبيق", "موبايل", "app"] },
      { label: "منصة SaaS", words: ["saas", "منصة"] },
      { label: "أتمتة بالذكاء الاصطناعي", words: ["أتمتة", "اتمتة", "ذكاء", "ai", "بوت"] },
      { label: "غير ذلك", words: ["غير", "اشي تاني", "شي تاني", "other"] }
    ]
  },
  budget: {
    ask: `تمام! شو الميزانية التقريبية؟
1- أقل من 1,500$
2- 1,500$ – 4,000$
3- أكثر من 4,000$
4- مش متأكد، بدي استشارة`,
    options: [
      { label: "أقل من 1,500$", words: ["أقل", "اقل"] },
      { label: "1,500$ – 4,000$", words: ["بين", "متوسط"] },
      { label: "أكثر من 4,000$", words: ["أكثر", "اكثر", "فوق"] },
      { label: "مش متأكد / استشارة", words: ["مش متأكد", "مش متاكد", "استشارة", "ما بعرف", "مش عارف"] }
    ]
  },
  timing: {
    ask: `وإيمتى بدك تبدأ؟
1- فورًا
2- خلال شهر
3- لسا بخطط`,
    options: [
      { label: "فورًا", words: ["فورا", "فورًا", "هلق", "هلأ", "حالا", "الآن", "اليوم"] },
      { label: "خلال شهر", words: ["شهر"] },
      { label: "لسا بخطط", words: ["بخطط", "لسا", "مش هلق", "بعدين"] }
    ]
  }
};

const ORDER = ["type", "budget", "timing"];

const HANDOFF = `شكرًا! وصل طلبك لفريق Rovira، وبنرد عليك شخصيًا خلال ساعتين بأوقات الدوام.
إذا حابب، اكتب هلأ بسطرين شو المشكلة اللي بدك تحلها 👇`;

const DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };

function parseChoice(text, options) {
  const t = String(text || "").replace(/[٠-٩]/g, d => DIGITS[d]).trim().toLowerCase();
  const n = t.match(/^\s*(\d)\b/);
  if (n) {
    const i = Number(n[1]) - 1;
    return i >= 0 && i < options.length ? i : null;
  }
  const hit = options.findIndex(o => o.words.some(w => t.includes(w.toLowerCase())));
  return hit >= 0 ? hit : null;
}

/** 🔥 = wants to start now AND budget is middle or high bracket. */
function isHot(answers) {
  return answers.timing === 0 && (answers.budget === 1 || answers.budget === 2);
}

function summary(answers, msg) {
  const parts = [
    STEPS.type.options[answers.type]?.label,
    STEPS.budget.options[answers.budget]?.label,
    STEPS.timing.options[answers.timing]?.label
  ];
  return `${isHot(answers) ? "🔥 " : ""}طلب جديد: ${parts.join(" · ")} · ${msg.name ? `${msg.name} ` : ""}+${msg.from}`;
}

/**
 * Returns true if the message was handled by the lead flow (start, an
 * answer, or the final free-text details). `send(text)` is Saad's reply().
 */
export async function handleLeadFlow({ msg, conv, send, logToSheet, setHumanMode }) {
  const convRef = db.collection("whatsappConversations").doc(msg.from);
  const flow = conv?.leadFlow || null;
  const text = msg.text || "";

  // Start (or restart) on the website's ready message.
  if (LEAD_TRIGGER.test(text)) {
    await convRef.set({ leadFlow: { step: "type", answers: {}, startedAt: new Date(), source: "website" } }, { merge: true });
    await send(STEPS.type.ask, { topic: "طلب مشروع", reason: null });
    return true;
  }

  if (!flow || flow.step === "done") return false;

  // Optional "two lines about the problem" after the hand-off.
  if (flow.step === "details") {
    await convRef.set({ leadFlow: { ...flow, step: "done", details: text || `[${msg.type}]`, doneAt: new Date() } }, { merge: true });
    await sendTelegramMessage(`📝 تفاصيل الطلب من +${msg.from}:\n«${text || `[${msg.type}]`}»\n\nاسحبي رسالته وردي عليه.`);
    await logToSheet({ name: msg.name, phone: msg.from, question: text, answer: "(تفاصيل طلب — للفريق)", status: "طلب مشروع", topic: "طلب مشروع" });
    await setHumanMode(); // Reem takes it from here
    return true;
  }

  const step = STEPS[flow.step];
  const choice = parseChoice(text, step.options);
  if (choice === null) {
    await send(`اختار رقم من 1 لـ ${step.options.length} لو سمحت 🙏\n\n${step.ask}`, { topic: "طلب مشروع" });
    return true;
  }

  const answers = { ...(flow.answers || {}), [flow.step]: choice };
  const next = ORDER[ORDER.indexOf(flow.step) + 1];

  if (next) {
    await convRef.set({ leadFlow: { ...flow, step: next, answers } }, { merge: true });
    await send(STEPS[next].ask, { topic: "طلب مشروع" });
    return true;
  }

  // Third answer in: hand off + notify Reem right away.
  await convRef.set({ leadFlow: { ...flow, step: "details", answers, completedAt: new Date(), hot: isHot(answers) } }, { merge: true });
  await send(HANDOFF, { topic: "طلب مشروع" });
  const line = summary(answers, msg);
  await sendTelegramMessage(`${line}${isHot(answers) ? "\n⏱ عميل جاهز — ردي عليه خلال ساعة." : ""}\n\nاسحبي أي رسالة منه وردي عليه.`);
  await logToSheet({ name: msg.name, phone: msg.from, question: line, answer: "(طلب مشروع — بانتظار الفريق)", status: isHot(answers) ? "🔥 طلب جاهز" : "طلب مشروع", topic: "طلب مشروع" });
  return true;
}
