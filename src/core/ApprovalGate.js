import { db } from "../config/firebase.js";
import { logAudit } from "./AuditLog.js";
import { requiresApproval } from "./Permissions.js";
import { sendWhatsAppAlert } from "../integrations/WhatsAppClient.js";
import { sendTelegramMessage } from "../integrations/TelegramClient.js";

/**
 * The single door every external/commercial action must pass through.
 *
 * An agent that wants to send a proposal, message a client, submit an
 * application, or spend money does NOT have a function to do that directly.
 * It has requestApproval(). That's it. This creates a WAITING_APPROVAL
 * record in Firestore and an audit log entry, alerts you, and returns — it
 * never executes the action itself. Only a human decision (decideApproval,
 * via approve.js / reject.js) can move it to APPROVED or REJECTED, and only
 * Executor.js — which re-checks APPROVED itself — can move an APPROVED
 * request to EXECUTED.
 *
 * Lifecycle: WAITING_APPROVAL → APPROVED → EXECUTED → VERIFIED
 *                             ↘ REJECTED (dead end, nothing executes)
 */
export async function requestApproval({ agentId, actionType, summary, payload = {} }) {
  if (!requiresApproval(actionType)) {
    // This function is ONLY for gated actions. Calling it for an internal
    // action is almost certainly a bug in the caller — fail loud.
    throw new Error(
      `requestApproval() called with actionType "${actionType}", which is marked INTERNAL in Permissions.js. ` +
      `Internal actions should just run directly, not go through the approval gate.`
    );
  }

  const ref = await db.collection("approvals").add({
    agentId,
    actionType,
    summary,
    payload,
    status: "WAITING_APPROVAL",
    requestedAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    executedAt: null
  });

  await logAudit({
    actorType: "agent",
    agentId,
    action: actionType,
    status: "BLOCKED_PENDING_APPROVAL",
    details: summary,
    relatedApprovalId: ref.id
  });

  console.log(`\n🔒 [Approval needed] ${agentId} → ${actionType}`);
  console.log(`   ${summary}`);
  console.log(`   Approve:  node src/approve.js ${ref.id}`);
  console.log(`   Reject:   node src/reject.js ${ref.id} "reason"\n`);

  // Two notification channels, neither one able to approve or execute
  // anything by itself — both just tell Reem something is waiting.
  // WhatsApp: quietly no-ops until configured (docs/WHATSAPP_SETUP.md).
  await sendWhatsAppAlert(
    `🔒 موافقة مطلوبة\n${agentId} → ${actionType}\n\n${summary}\n\nApprove: node src/approve.js ${ref.id}\nReject: node src/reject.js ${ref.id} "reason"`
  );

  // Telegram: the primary channel once TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
  // are set (docs/TELEGRAM_SETUP.md) — replying with /approve or /reject
  // here goes through the exact same decideApproval() as the CLI.
  await sendTelegramMessage(
    `🔒 موافقة مطلوبة\n${agentId} → ${actionType}\n\n${summary}\n\n/approve ${ref.id}\n/reject ${ref.id} سبب`
  );

  return ref.id;
}

export async function getApproval(approvalId) {
  const doc = await db.collection("approvals").doc(approvalId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// Sorted by requestedAt in JS (not a Firestore orderBy) on purpose — adding
// orderBy() to a query that already has a where() on a different field
// would need a new Firestore composite index (same error the LinkedIn agent
// hit on contentIdeas). Sorting client-side avoids that entirely; this
// collection is always small (a handful of pending items at most). Stable
// order matters because the Telegram bot numbers these as "1", "2", ... and
// needs that order to stay put between a listing and "approve the first one".
export async function listPendingApprovals() {
  const snapshot = await db.collection("approvals").where("status", "==", "WAITING_APPROVAL").get();
  const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  return items.sort((a, b) => (a.requestedAt?.toMillis?.() ?? 0) - (b.requestedAt?.toMillis?.() ?? 0));
}

/**
 * The ONLY function in the codebase that can move an approval out of
 * WAITING_APPROVAL. Called by approve.js / reject.js (human-run CLI) and by
 * the test harness — never by an agent.
 */
export async function decideApproval(approvalId, decision, { decidedBy = "reem", reason = null } = {}) {
  if (!["approve", "reject"].includes(decision)) {
    throw new Error(`decision must be "approve" or "reject", got "${decision}"`);
  }

  const ref = db.collection("approvals").doc(approvalId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error(`No approval request found with id "${approvalId}".`);

  const data = doc.data();
  if (data.status !== "WAITING_APPROVAL") {
    return { alreadyDecided: true, status: data.status, summary: data.summary, agentId: data.agentId, actionType: data.actionType };
  }

  const newStatus = decision === "approve" ? "APPROVED" : "REJECTED";

  await ref.update({
    status: newStatus,
    decidedAt: new Date(),
    decidedBy,
    decisionNote: reason
  });

  await logAudit({
    actorType: "user",
    agentId: data.agentId,
    action: data.actionType,
    status: newStatus,
    details: reason || data.summary,
    relatedApprovalId: approvalId
  });

  // Best-effort sync of the linked opportunity record, if there is one —
  // not required for every actionType, so failures here don't block the
  // decision itself.
  if (data.payload?.opportunityId) {
    try {
      await db.collection("opportunities").doc(data.payload.opportunityId).update({
        approvalStatus: newStatus
      });
    } catch (_) {
      // no-op — opportunity sync is a convenience, not a source of truth
    }
  }

  return { alreadyDecided: false, status: newStatus, summary: data.summary, agentId: data.agentId, actionType: data.actionType };
}
