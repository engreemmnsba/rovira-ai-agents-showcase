import { db } from "../config/firebase.js";

/**
 * Create a new opportunity in Firestore
 */
export async function createOpportunity(data) {
  try {
    const docRef = await db.collection("opportunities").add({
      ...data,
      createdAt: new Date(),
      status: "FOUND"
    });
    console.log("✅ Opportunity created with ID:", docRef.id);
    return docRef.id;
  } catch (error) {
    console.error("❌ Error creating opportunity:", error);
    throw error;
  }
}

/**
 * Look up an opportunity we've already created for this platform+externalId,
 * so a repeated search (e.g. the same project still open 3 hours later)
 * doesn't create a duplicate and re-request approval for something already
 * queued or decided.
 */
export async function getOpportunityByExternalId(platform, externalId) {
  try {
    const snapshot = await db
      .collection("opportunities")
      .where("platform", "==", platform)
      .where("externalId", "==", externalId)
      .limit(1)
      .get();
    return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  } catch (error) {
    console.error("❌ Error checking for existing opportunity:", error);
    throw error;
  }
}

/**
 * Get all pending opportunities awaiting approval
 */
export async function getPendingOpportunities() {
  try {
    const snapshot = await db
      .collection("opportunities")
      .where("status", "==", "FOUND")
      .orderBy("createdAt", "desc")
      .get();

    const opportunities = [];
    snapshot.forEach(doc => {
      opportunities.push({ id: doc.id, ...doc.data() });
    });
    console.log(`✅ Found ${opportunities.length} pending opportunities`);
    return opportunities;
  } catch (error) {
    console.error("❌ Error fetching pending opportunities:", error);
    throw error;
  }
}

/**
 * Everything that happened today, across every collection agents write to —
 * used for the Telegram bot's daily status briefing ("شو عملتو اليوم؟").
 * Three independent single-field range queries (createdAt >= today), each
 * fine on Firestore's automatic per-field index — no composite index needed
 * since none of these combine a second filter or an orderBy.
 */
export async function getTodaysActivity() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [tasksSnap, opportunitiesSnap, linkedinPostsSnap] = await Promise.all([
    db.collection("tasks").where("createdAt", ">=", startOfDay).get(),
    db.collection("opportunities").where("createdAt", ">=", startOfDay).get(),
    db.collection("linkedinPosts").where("createdAt", ">=", startOfDay).get()
  ]);

  return {
    tasks: tasksSnap.docs.map(doc => doc.data()),
    opportunities: opportunitiesSnap.docs.map(doc => doc.data()),
    linkedinPosts: linkedinPostsSnap.docs.map(doc => doc.data())
  };
}

/**
 * Log an action in the audit trail
 */
export async function logAction(action, details) {
  try {
    await db.collection("logs").add({
      action,
      details,
      timestamp: new Date(),
      status: "success"
    });
    console.log("✅ Action logged:", action);
  } catch (error) {
    console.error("❌ Error logging action:", error);
    throw error;
  }
}

/**
 * Get user profile and preferences
 */
export async function getUserProfile() {
  try {
    const doc = await db.collection("userProfile").doc("reem").get();
    if (doc.exists) {
      console.log("✅ User profile found");
      return doc.data();
    } else {
      console.log("⚠️  User profile not found, creating default...");
      const defaultProfile = {
        name: "Reem Mansour",
        email: process.env.OWNER_EMAIL || "you@example.com",
        whatsapp: process.env.OWNER_WHATSAPP || "+10000000000",
        skills: ["Flutter", "ASP.NET Core", "Firebase", "SQL Server", "Docker", "DigitalOcean", "Cloudflare"],
        platforms: ["Mostaql", "Khamsat", "Upwork", "Fiverr", "People Per Hour", "Freelancer"],
        proposalStyle: "human, value-focused",
        createdAt: new Date()
      };
      await db.collection("userProfile").doc("reem").set(defaultProfile);
      console.log("✅ Default profile created");
      return defaultProfile;
    }
  } catch (error) {
    console.error("❌ Error getting user profile:", error);
    throw error;
  }
}

/**
 * Approve an opportunity
 */
export async function approveOpportunity(opportunityId) {
  try {
    await db.collection("opportunities").doc(opportunityId).update({
      status: "APPROVED",
      approvedAt: new Date()
    });
    console.log("✅ Opportunity approved:", opportunityId);
  } catch (error) {
    console.error("❌ Error approving opportunity:", error);
    throw error;
  }
}

/**
 * Reject an opportunity
 */
export async function rejectOpportunity(opportunityId) {
  try {
    await db.collection("opportunities").doc(opportunityId).update({
      status: "REJECTED",
      rejectedAt: new Date()
    });
    console.log("✅ Opportunity rejected:", opportunityId);
  } catch (error) {
    console.error("❌ Error rejecting opportunity:", error);
    throw error;
  }
}