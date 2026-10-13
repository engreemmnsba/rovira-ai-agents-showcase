import { db } from "../config/firebase.js";

/**
 * Per-agent editable instructions/playbook, stored in Firestore
 * (agentInstructions/<agentId>) so Reem can change how an agent drafts or
 * prioritizes without asking for a code change — e.g. the content pillars,
 * narrative frameworks, and publishing rules she sets for the LinkedIn
 * Content Agent. Read fresh on every call: these agents only run a few
 * times a day/week, so there's no real benefit to an in-memory cache here
 * (unlike userProfile, which FreelanceSearchAgent reads on every 5-minute
 * poll and so does cache).
 *
 * Does not touch the approval gate — this only changes how an agent drafts
 * or prioritizes, never whether its output still needs Reem's explicit
 * approval to execute.
 */
export async function getAgentInstructions(agentId) {
    const doc = await db.collection("agentInstructions").doc(agentId).get();
    return doc.exists ? doc.data().text || null : null;
}

export async function setAgentInstructions(agentId, text) {
    await db.collection("agentInstructions").doc(agentId).set({
          text,
          updatedAt: new Date()
    });
}
