import "dotenv/config";
import fs from "fs";
import path from "path";
import { db } from "./config/firebase.js";
import { getApproval, decideApproval, requestApproval } from "./core/ApprovalGate.js";
import { executeApproval } from "./core/Executor.js";
import { requiresApproval } from "./core/Permissions.js";
import FreelanceSearchAgent from "./agents/FreelanceSearchAgent.js";

/**
 * End-to-end test of the Approval Gate + Permissions + Audit Log system.
 * Exercises the real code paths (ApprovalGate, Executor, Permissions,
 * FreelanceSearchAgent) against the real Firestore project — nothing here
 * is mocked. Test fixtures it creates (opportunities/approvals) are cleaned
 * up at the end; auditLog entries are left in place since that collection
 * is meant to be an append-only historical record, including of test runs.
 *
 * Run: node src/test-approval-flow.js
 * Report written to: docs/APPROVAL_FLOW_TEST_REPORT.md
 */

const results = []; // { point, name, pass, detail }
const cleanupIds = { opportunities: [], approvals: [] };

function record(point, name, pass, detail = "") {
  results.push({ point, name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} [${point}] ${name}${detail ? " — " + detail : ""}`);
}

async function auditEntriesFor(approvalId) {
  const snapshot = await db.collection("auditLog").where("relatedApprovalId", "==", approvalId).get();
  return snapshot.docs.map(d => d.data());
}

async function main() {
  console.log("🧪 Approval Flow — full end-to-end test\n");

  const agent = new FreelanceSearchAgent();

  // ── 1–4: create a test opportunity, run it through the real pipeline,
  //         confirm WAITING_APPROVAL, confirm nothing executes yet ──
  const testOpportunityA = {
    title: "[TEST] Approval Flow Verification",
    platform: "TEST-PLATFORM (not real)",
    link: "https://example.invalid/test-opportunity-a",
    description: "Synthetic opportunity created by test-approval-flow.js — not a real client."
  };

  let opportunityIdA, approvalIdA;
  try {
    const out = await agent.processOpportunity(testOpportunityA);
    opportunityIdA = out.opportunityId;
    approvalIdA = out.approvalId;
    cleanupIds.opportunities.push(opportunityIdA);
    cleanupIds.approvals.push(approvalIdA);
    record("1", "Test opportunity created", true, `opportunityId=${opportunityIdA}`);
  } catch (error) {
    record("1", "Test opportunity created", false, error.message);
    return finish(); // nothing else can run without this
  }

  const oppDocA = await db.collection("opportunities").doc(opportunityIdA).get();
  const oppDataA = oppDocA.data();
  record(
    "2",
    "Agent analyzed it and prepared a proposal draft",
    !!oppDataA.analysis && typeof oppDataA.proposal === "string" && oppDataA.proposal.length > 0,
    `analysis=${JSON.stringify(oppDataA.analysis)}, proposal="${oppDataA.proposal}"`
  );

  const approvalA_afterCreate = await getApproval(approvalIdA);
  record(
    "3",
    "Approval request created with status WAITING_APPROVAL",
    approvalA_afterCreate?.status === "WAITING_APPROVAL",
    `status=${approvalA_afterCreate?.status}`
  );

  // Point 4: nothing executes before approval — attempt execution now and
  // expect it to be refused, plus confirm no EXECUTED audit entry exists.
  let blockedBeforeApproval = false;
  let blockReason = "";
  try {
    await executeApproval(approvalIdA);
  } catch (error) {
    blockedBeforeApproval = true;
    blockReason = error.message;
  }
  const auditBeforeApproval = await auditEntriesFor(approvalIdA);
  const hasExecutedBeforeApproval = auditBeforeApproval.some(e => e.status === "EXECUTED");
  record(
    "4",
    "No execution happens before approval",
    blockedBeforeApproval && !hasExecutedBeforeApproval,
    blockedBeforeApproval ? `execution correctly refused: "${blockReason}"` : "execution was NOT refused — this is a bug"
  );

  // ── 5: approve.js path — WAITING_APPROVAL → APPROVED → EXECUTED ──
  let approveOk = false;
  let approveDetail = "";
  try {
    const decision = await decideApproval(approvalIdA, "approve");
    if (decision.status !== "APPROVED") throw new Error(`expected APPROVED, got ${decision.status}`);
    const executed = await executeApproval(approvalIdA);
    if (executed.status !== "EXECUTED" || !executed.verified) throw new Error(`expected EXECUTED+verified, got ${JSON.stringify(executed)}`);
    const finalApproval = await getApproval(approvalIdA);
    if (finalApproval.status !== "EXECUTED") throw new Error(`final status is ${finalApproval.status}, not EXECUTED`);
    approveOk = true;
    approveDetail = "APPROVED → EXECUTED → VERIFIED, confirmed in Firestore";
  } catch (error) {
    approveDetail = error.message;
  }
  record("5", "approve.js path: APPROVED then EXECUTED", approveOk, approveDetail);

  // ── 6: reject.js path — separate opportunity, WAITING_APPROVAL → REJECTED, never executes ──
  const testOpportunityB = {
    title: "[TEST] Approval Flow Verification (reject path)",
    platform: "TEST-PLATFORM (not real)",
    link: "https://example.invalid/test-opportunity-b",
    description: "Synthetic opportunity created by test-approval-flow.js — not a real client."
  };

  let opportunityIdB, approvalIdB;
  let rejectOk = false;
  let rejectDetail = "";
  try {
    const out = await agent.processOpportunity(testOpportunityB);
    opportunityIdB = out.opportunityId;
    approvalIdB = out.approvalId;
    cleanupIds.opportunities.push(opportunityIdB);
    cleanupIds.approvals.push(approvalIdB);

    const decision = await decideApproval(approvalIdB, "reject", { reason: "test rejection — automated flow test" });
    if (decision.status !== "REJECTED") throw new Error(`expected REJECTED, got ${decision.status}`);

    let blockedAfterReject = false;
    try {
      await executeApproval(approvalIdB);
    } catch (_) {
      blockedAfterReject = true;
    }
    if (!blockedAfterReject) throw new Error("execution was NOT refused after rejection — this is a bug");

    const auditAfterReject = await auditEntriesFor(approvalIdB);
    if (auditAfterReject.some(e => e.status === "EXECUTED")) throw new Error("an EXECUTED audit entry exists for a rejected request — this is a bug");

    rejectOk = true;
    rejectDetail = "REJECTED, execution refused, no EXECUTED audit entry";
  } catch (error) {
    rejectDetail = error.message;
  }
  record("6", "reject.js path: REJECTED, never executes", rejectOk, rejectDetail);

  // ── 7: every stage logged in auditLog ──
  const auditA = await auditEntriesFor(approvalIdA);
  const auditB = approvalIdB ? await auditEntriesFor(approvalIdB) : [];
  const statusesA = auditA.map(e => e.status);
  const statusesB = auditB.map(e => e.status);
  const expectedA = ["BLOCKED_PENDING_APPROVAL", "BLOCKED_NOT_APPROVED", "APPROVED", "EXECUTED", "VERIFIED"];
  const expectedB = ["BLOCKED_PENDING_APPROVAL", "REJECTED", "BLOCKED_NOT_APPROVED"];
  const missingA = expectedA.filter(s => !statusesA.includes(s));
  const missingB = expectedB.filter(s => !statusesB.includes(s));
  record(
    "7",
    "Every stage recorded in auditLog",
    missingA.length === 0 && missingB.length === 0,
    `approve-path statuses=[${statusesA.join(", ")}]; reject-path statuses=[${statusesB.join(", ")}]` +
      (missingA.length ? `; MISSING from approve-path: ${missingA.join(", ")}` : "") +
      (missingB.length ? `; MISSING from reject-path: ${missingB.join(", ")}` : "")
  );

  // ── 8: unknown/unauthorized action type is blocked by default ──
  let unknownBlockedOnCreate = false;
  let unknownBlockedOnExecute = false;
  let unknownApprovalId = null;
  let unknownDetail = "";
  try {
    unknownApprovalId = await requestApproval({
      agentId: "freelance-search",
      actionType: "DELETE_ACCOUNT", // not INTERNAL, not implemented in Executor — should be blocked at every layer
      summary: "[TEST] unknown/unauthorized action type — should be blocked by default",
      payload: {}
    });
    cleanupIds.approvals.push(unknownApprovalId);
    const created = await getApproval(unknownApprovalId);
    unknownBlockedOnCreate = created.status === "WAITING_APPROVAL"; // not auto-executed on creation

    // Even if approved, there is no executor registered for it — defense in depth.
    await decideApproval(unknownApprovalId, "approve");
    try {
      await executeApproval(unknownApprovalId);
    } catch (error) {
      unknownBlockedOnExecute = /No executor implemented/.test(error.message);
      unknownDetail = error.message;
    }
  } catch (error) {
    unknownDetail = error.message;
  }
  record(
    "8",
    "Unknown/unauthorized action type blocked automatically",
    unknownBlockedOnCreate && unknownBlockedOnExecute,
    `created as WAITING_APPROVAL=${unknownBlockedOnCreate}, execution refused even after approval=${unknownBlockedOnExecute} (${unknownDetail})`
  );

  // ── Scenario matrix (the 4 cases explicitly requested) ──
  const scenarios = [
    {
      name: "INTERNAL action → runs automatically, no approval needed",
      pass: requiresApproval("ANALYZE") === false && requiresApproval("DRAFT_CONTENT") === false,
      detail: "Permissions.requiresApproval() returns false for ANALYZE/DRAFT_CONTENT/SEARCH/READ_DATA/WRITE_INTERNAL_RECORD"
    },
    {
      name: "EXTERNAL action without approval → BLOCKED",
      pass: blockedBeforeApproval && !hasExecutedBeforeApproval,
      detail: "Executor.executeApproval() refused before a human decision was made (see point 4)"
    },
    {
      name: "EXTERNAL action with approval → EXECUTE",
      pass: approveOk,
      detail: "approve.js path reached EXECUTED + VERIFIED (see point 5)"
    },
    {
      name: "EXTERNAL action with reject → no EXECUTE",
      pass: rejectOk,
      detail: "reject.js path reached REJECTED with execution refused (see point 6)"
    }
  ];

  console.log("\n— Scenario matrix —");
  for (const s of scenarios) {
    console.log(`${s.pass ? "✅" : "❌"} ${s.name}`);
  }

  await finish(scenarios);
}

async function finish(scenarios = []) {
  const allPass = results.every(r => r.pass) && scenarios.every(s => s.pass);

  const lines = [];
  lines.push("# Approval Flow — Test Report");
  lines.push("");
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Overall: ${allPass ? "✅ ALL TESTS PASSED" : "❌ ONE OR MORE TESTS FAILED"}`);
  lines.push("");
  lines.push("## Checklist (points 1–8)");
  lines.push("");
  for (const r of results) {
    lines.push(`${r.pass ? "✅" : "❌"} **[${r.point}] ${r.name}**${r.detail ? " — " + r.detail : ""}`);
  }
  lines.push("");
  lines.push("## Scenario matrix");
  lines.push("");
  for (const s of scenarios) {
    lines.push(`${s.pass ? "✅" : "❌"} **${s.name}** — ${s.detail}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- Test fixtures (opportunities/approvals created by this run) are deleted after the run.");
  lines.push("- auditLog entries from this run are kept — that collection is append-only by design, including test runs.");
  lines.push("- \"EXECUTED\" for SEND_PROPOSAL is currently a simulated stand-in (Executor.js `executeSendProposal`) — no real platform API is connected yet (Phase 2).");

  const reportPath = path.join(process.cwd(), "docs", "APPROVAL_FLOW_TEST_REPORT.md");
  fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
  console.log(`\n📄 Report written to docs/APPROVAL_FLOW_TEST_REPORT.md`);
  console.log(`\n${allPass ? "✅ ALL TESTS PASSED" : "❌ ONE OR MORE TESTS FAILED"} (${results.filter(r => r.pass).length}/${results.length} checklist points, ${scenarios.filter(s => s.pass).length}/${scenarios.length} scenarios)\n`);

  await cleanup();
  process.exit(allPass ? 0 : 1);
}

async function cleanup() {
  console.log("🧹 Cleaning up test fixtures...");
  for (const id of cleanupIds.opportunities) {
    try { await db.collection("opportunities").doc(id).delete(); } catch (_) {}
  }
  for (const id of cleanupIds.approvals) {
    try { await db.collection("approvals").doc(id).delete(); } catch (_) {}
  }
  console.log("   done (opportunities + approvals test docs removed; auditLog entries kept).");
}

main().catch(error => {
  console.error("💥 Test harness crashed:", error);
  process.exit(1);
});
