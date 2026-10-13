import { db } from "../config/firebase.js";

/**
 * Every action taken (or attempted, or blocked, or decided) anywhere in the
 * system is written here. This collection is append-only from the app's
 * point of view — nothing in this codebase updates or deletes an auditLog
 * document, only adds one.
 */
export async function logAudit({
  actorType,            // "agent" | "user" | "system"
  agentId = null,
  action,                // actionType, e.g. "SEND_PROPOSAL"
  status,                // "ATTEMPTED" | "BLOCKED_PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED"
  details = "",
  relatedApprovalId = null,
  relatedTaskId = null
}) {
  try {
    await db.collection("auditLog").add({
      actorType,
      agentId,
      action,
      status,
      details,
      relatedApprovalId,
      relatedTaskId,
      timestamp: new Date()
    });
  } catch (error) {
    // Audit logging must never crash the caller — but a silent failure here
    // is exactly the kind of thing that should be loud in the console.
    console.error("⚠️  Failed to write audit log entry:", error.message);
  }
}
