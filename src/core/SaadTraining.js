import { db } from "../config/firebase.js";
import { getAgentInstructions, setAgentInstructions } from "./AgentInstructions.js";

/**
 * How Reem trains "سعد" from Telegram — three layers, all read fresh on
 * every reply. None of them can override the hard rules in SaadAgent.js
 * (no prices / dates / promises, never naming Reem): those live in code,
 * and the price/date guard runs on every draft no matter what it learned.
 *
 * 1. Rules (agentInstructions/whatsapp-support): tone, greeting, what to
 *    ask first, what to always escalate. Full-replace text, like the
 *    Instagram/LinkedIn playbooks.
 * 2. Approved answers (saadAnswers): "when asked X, answer Y". Added from
 *    chat, or by swiping Saad's reply and writing "علّم: ..." on Telegram.
 * 3. Examples (saadExamples): every reply Reem sends a customer herself is
 *    saved with the question it answered; Saad copies her style from the
 *    latest ones automatically.
 */

const AGENT_ID = "whatsapp-support";

export const getSaadRules = () => getAgentInstructions(AGENT_ID);
export const setSaadRules = text => setAgentInstructions(AGENT_ID, text);

export async function addSaadAnswer(question, answer, source = "reem") {
  const ref = await db.collection("saadAnswers").add({ question: question || "", answer, source, active: true, createdAt: new Date() });
  return ref.id;
}

export async function listSaadAnswers() {
  const snap = await db.collection("saadAnswers").where("active", "==", true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function removeSaadAnswer(id) {
  await db.collection("saadAnswers").doc(id).update({ active: false, removedAt: new Date() });
}

export async function addSaadExample(question, answer) {
  if (!answer) return;
  await db.collection("saadExamples").add({ question: question || "", answer, createdAt: new Date() });
}

async function recentExamples(limit = 8) {
  const snap = await db.collection("saadExamples").orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map(d => d.data()).reverse();
}

/** The block SaadAgent adds to its prompt. */
export async function getSaadTrainingBlock() {
  const [rules, answers, examples] = await Promise.all([getSaadRules(), listSaadAnswers(), recentExamples()]);
  const parts = [];
  if (rules) parts.push(`قواعد ريم لسعد (اتبعها، بس القواعد الصارمة فوق إلها الأولوية):\n${rules}`);
  if (answers.length) {
    parts.push(
      `أجوبة معتمدة من الفريق — إذا السؤال بيشبه واحد منها، جاوب بنفس المعنى والأسلوب:\n${answers
        .map(a => `- سؤال: ${a.question || "(عام)"}\n  جواب: ${a.answer}`)
        .join("\n")}`
    );
  }
  if (examples.length) {
    parts.push(
      `أمثلة على ردود الفريق الحقيقية — قلّد طريقة الكلام والطول والنبرة، مش التفاصيل الخاصة بكل زبون:\n${examples
        .map(e => `- الزبون: ${e.question || "…"}\n  الفريق: ${e.answer}`)
        .join("\n")}`
    );
  }
  return parts.join("\n\n");
}
