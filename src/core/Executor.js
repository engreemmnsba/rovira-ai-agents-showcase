import { db } from "../config/firebase.js";
import { logAudit } from "./AuditLog.js";
import { getApproval } from "./ApprovalGate.js";
import { createTextPost, getStoredPersonUrn } from "../integrations/LinkedInClient.js";
import { publishContainer } from "../integrations/InstagramClient.js";
import { isFacebookPageConfigured, publishPagePhoto } from "../integrations/FacebookPageClient.js";
import { logCompanyUpdate } from "./CompanyKnowledge.js";

/**
* One executor function per actionType, registered explicitly. An
* actionType with no entry here CANNOT execute, even if somehow approved —
* there's simply no code path that would do anything with it.
*/
const EXECUTORS = {
SEND_PROPOSAL: executeSendProposal,
POST_PUBLIC_CONTENT: executePostToLinkedIn,
POST_INSTAGRAM_CONTENT: executePostToInstagram
};

/**
* The ONLY function that performs a gated action. Called after a human
* decision (from approve.js, or a future WhatsApp-driven approval). Re-
* verifies APPROVED itself — never trusts the caller — then executes, then
* verifies its own result before returning.
*/
export async function executeApproval(approvalId) {
const approval = await getApproval(approvalId);
if (!approval) throw new Error(`No approval found: ${approvalId}`);

if (approval.status !== "APPROVED") {
await logAudit({
actorType: "system",
agentId: approval.agentId,
action: approval.actionType,
status: "BLOCKED_NOT_APPROVED",
details: `Execution refused — approval status is "${approval.status}", not APPROVED.`,
relatedApprovalId: approvalId
});
throw new Error(`Refusing to execute ${approvalId}: status is "${approval.status}", not APPROVED.`);
}

const executor = EXECUTORS[approval.actionType];
if (!executor) {
await logAudit({
actorType: "system",
agentId: approval.agentId,
action: approval.actionType,
status: "BLOCKED_NO_EXECUTOR",
details: `No executor implemented for actionType "${approval.actionType}" — refusing to execute.`,
relatedApprovalId: approvalId
});
throw new Error(`No executor implemented for actionType "${approval.actionType}".`);
}

const result = await executor(approval);

await db.collection("approvals").doc(approvalId).update({
status: "EXECUTED",
executedAt: new Date()
});

await logAudit({
actorType: "system",
agentId: approval.agentId,
action: approval.actionType,
status: "EXECUTED",
details: result.details,
relatedApprovalId: approvalId
});

// Auto-feed the shared company knowledge log with what just happened --
// most agents never need to tell Reem to log this themselves.
await logCompanyUpdate(`${approval.agentId}: ${result.details}`, "auto");

return verifyExecution(approvalId, approval);
}

/**
* Re-reads the approval after execution and confirms the state actually
* moved to EXECUTED before calling it done. Logs VERIFIED (or FAILED if
* the post-state doesn't match what we expect).
*/
async function verifyExecution(approvalId, approval) {
const doc = await db.collection("approvals").doc(approvalId).get();
const ok = doc.exists && doc.data().status === "EXECUTED";

await logAudit({
actorType: "system",
agentId: approval.agentId,
action: approval.actionType,
status: ok ? "VERIFIED" : "FAILED",
details: ok ? "Post-execution state confirmed as EXECUTED." : "Post-execution verification did not find EXECUTED status.",
relatedApprovalId: approvalId
});

if (!ok) throw new Error(`Verification failed for approval ${approvalId}`);
return { id: approvalId, status: "EXECUTED", verified: true };
}

/**
* STUB — Phase 2 replaces the body of this function with the real
* Mostaql/Upwork/Fiverr/... API call. Everything around it (the APPROVED
* guard in executeApproval, the audit trail, the verify step) stays
* exactly as-is; this is the only place that changes.
*/
async function executeSendProposal(approval) {
const { opportunityId, platform } = approval.payload;

if (opportunityId) {
await db.collection("opportunities").doc(opportunityId).update({
approvalStatus: "EXECUTED",
executedAt: new Date()
});
}

console.log(`📤 [SIMULATED SEND] Would submit the proposal to ${platform} now — no platform API connected yet (Phase 2).`);

return { details: `Simulated send to ${platform} — real platform API integration is Phase 2, not yet built.` };
}

/**
* REAL — not a stand-in. Publishes to LinkedIn via the officially self-serve
* "Share on LinkedIn" API (w_member_social). This only runs once a human has
* approved this exact text; there is no other code path in this codebase
* that can reach LinkedIn's publish endpoint.
*/
async function executePostToLinkedIn(approval) {
const { postId, text } = approval.payload;
const personUrn = getStoredPersonUrn();

const { postId: linkedinPostId } = await createTextPost({ personUrn, text });

if (postId) {
await db.collection("linkedinPosts").doc(postId).update({
approvalStatus: "EXECUTED",
linkedinPostId: linkedinPostId || null,
executedAt: new Date()
});
}

return { details: `Published to LinkedIn (${linkedinPostId || "no id returned"}).` };
}

/**
* REAL — not a stand-in. Publishes the already-created Instagram media
* container (see InstagramContentAgent.run / InstagramClient.createMediaContainer)
* via the official Instagram content-publishing API. This only runs once a
* human has approved this exact caption + image; container creation itself
* happened earlier and is invisible to anyone until this call.
*/
async function executePostToInstagram(approval) {
const { postId, creationId } = approval.payload;

const { postId: instagramPostId } = await publishContainer(creationId);

if (postId) {
await db.collection("instagramPosts").doc(postId).update({
approvalStatus: "EXECUTED",
instagramPostId: instagramPostId || null,
executedAt: new Date()
});
}

// Same approval covers the Facebook page: Reem approved this exact image
// + caption. A Facebook failure never undoes or fails the Instagram post.
let facebookNote = "";
if (isFacebookPageConfigured()) {
try {
const post = postId ? (await db.collection("instagramPosts").doc(postId).get()).data() : null;
if (post?.imageUrl) {
const { postId: facebookPostId } = await publishPagePhoto(post.imageUrl, post.caption || approval.payload.caption || "");
await db.collection("instagramPosts").doc(postId).update({ facebookPostId });
facebookNote = ` + Facebook (${facebookPostId})`;
}
} catch (error) {
console.error("⚠️ Facebook cross-post failed:", error.message);
facebookNote = ` — Facebook cross-post failed: ${error.message}`;
}
}

return { details: `Published to Instagram (${instagramPostId || "no id returned"})${facebookNote}.` };
}
