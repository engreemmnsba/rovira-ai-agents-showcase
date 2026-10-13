import { db } from "../config/firebase.js";

/**
 * "One draft at a time" check for the content agents, based on what is
 * REALLY waiting in the approvals queue — not on the post record alone.
 *
 * Before this, the agents skipped whenever any post doc said
 * WAITING_APPROVAL. A draft that was rejected, or whose publish failed,
 * never got its post doc updated, so it blocked every future run forever
 * — silently (the bot still said "done").
 *
 * Returns the waiting approval id if one exists. Otherwise marks any
 * leftover WAITING_APPROVAL post docs as STALE and returns null.
 */
export async function findWaitingDraft(collection, agentId) {
  const approvals = await db.collection("approvals").where("status", "==", "WAITING_APPROVAL").get();
  const waiting = approvals.docs.find(doc => doc.data().agentId === agentId);
  if (waiting) return waiting.id;

  const leftovers = await db.collection(collection).where("approvalStatus", "==", "WAITING_APPROVAL").get();
  for (const doc of leftovers.docs) {
    await doc.ref.update({ approvalStatus: "STALE", staleAt: new Date() });
  }
  if (!leftovers.empty) console.log(`🧹 [${agentId}] Cleared ${leftovers.size} stale draft record(s) with no live approval.`);
  return null;
}
