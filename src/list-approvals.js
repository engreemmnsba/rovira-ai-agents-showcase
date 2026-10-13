import "dotenv/config";
import { listPendingApprovals } from "./core/ApprovalGate.js";

async function main() {
  const pending = await listPendingApprovals();

  if (pending.length === 0) {
    console.log("✅ No approvals waiting.");
    return;
  }

  console.log(`\n🔒 ${pending.length} approval(s) waiting:\n`);
  for (const item of pending) {
    console.log(`— ${item.id}`);
    console.log(`  Agent: ${item.agentId}  |  Action: ${item.actionType}`);
    console.log(`  ${item.summary}`);
    console.log(`  Approve: node src/approve.js ${item.id}`);
    console.log(`  Reject:  node src/reject.js ${item.id} "reason"\n`);
  }
}

main();
