import { db } from "../config/firebase.js";

/**
 * A simple FIFO queue Reem can add to ahead of time (src/add-content-idea.js)
 * so scheduled LinkedIn drafts aren't limited to the random project rotation.
 * Purely internal bookkeeping — nothing here posts anything or needs approval.
 */
export async function addContentIdea(text) {
  const ref = await db.collection("contentIdeas").add({
    text,
    used: false,
    createdAt: new Date()
  });
  return ref.id;
}

/**
 * Oldest not-yet-used idea, if any. Note: this compound query (used == false,
 * ordered by createdAt) may ask Firestore for a composite index the first
 * time it runs — same as getPendingOpportunities() did. If so, open the
 * console link the error prints and wait for the index to finish building.
 */
export async function getNextContentIdea() {
  const snapshot = await db
    .collection("contentIdeas")
    .where("used", "==", false)
    .orderBy("createdAt", "asc")
    .limit(1)
    .get();

  return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

export async function markContentIdeaUsed(ideaId) {
  await db.collection("contentIdeas").doc(ideaId).update({
    used: true,
    usedAt: new Date()
  });
}
