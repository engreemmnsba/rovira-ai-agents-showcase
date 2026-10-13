import { db } from "../config/firebase.js";

/**
 * Shared knowledge layer every agent reads before acting -- the single
 * place for company info and recent news, so Reem explains things once
 * instead of per-agent. Same editable pattern as AgentInstructions.js, but
 * company-wide instead of per-agent:
 *
 * - companyProfile/main: one free-text doc Reem edits directly (services,
 *   portfolio, pricing policy, brand voice, her own work standards/quality
 *   bar) -- full-replace, like setAgentInstructions.
 * - companyUpdates: a rolling, timestamped log of what happened. Most
 *   entries are written automatically by Executor.js right after a real
 *   action executes (source: "auto"); Reem can also log one manually from
 *   Telegram for anything no agent would know about on its own -- an
 *   external client call, a decision (source: "manual").
 *
 * Read fresh on every call -- no cache, same reasoning as
 * AgentInstructions.js (these agents run a few times a day/week at most).
 */
export async function getCompanyProfile() {
    const doc = await db.collection("companyProfile").doc("main").get();
    return doc.exists ? doc.data().text || null : null;
}

export async function setCompanyProfile(text) {
    await db.collection("companyProfile").doc("main").set({
          text,
          updatedAt: new Date()
    });
}

export async function logCompanyUpdate(text, source = "manual") {
    try {
          await db.collection("companyUpdates").add({
                  text,
                  source, // "manual" | "auto"
                  createdAt: new Date()
          });
    } catch (error) {
          // Never let a logging failure break the action that triggered it.
      console.error("Failed to log company update:", error.message);
    }
}

export async function getRecentUpdates(limit = 15) {
    const snap = await db.collection("companyUpdates").orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs
      .map(doc => {
              const data = doc.data();
              return {
                        text: data.text,
                        source: data.source,
                        createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null
              };
      })
      .reverse(); // oldest-first -- reads more naturally as a timeline
}

/**
 * The single function every content/drafting agent calls before writing
 * anything -- combines the standing company profile with a short recent-
 * activity digest into one ready-to-inject block. Keeps every agent's
 * prompt-building code identical instead of each reimplementing this.
 */
export async function getCompanyContext() {
    const [profile, updates] = await Promise.all([getCompanyProfile(), getRecentUpdates(15)]);

  if (!profile && updates.length === 0) return null;

  let block = "";
    if (profile) block += `معلومات روفيرا الثابتة:\n${profile}\n`;
    if (updates.length > 0) {
          block += `\nآخر الأخبار (الأحدث آخرًا):\n${updates.map(u => `- ${u.text}`).join("\n")}\n`;
    }
    return block.trim();
}
