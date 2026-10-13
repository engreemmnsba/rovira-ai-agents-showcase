import "dotenv/config";
import { decideApproval } from "./core/ApprovalGate.js";
import { executeApproval } from "./core/Executor.js";

const [, , approvalId] = process.argv;

if (!approvalId) {
  console.log("Usage: node src/approve.js <approvalId>");
  process.exit(1);
}

async function main() {
  const result = await decideApproval(approvalId, "approve");

  if (result.alreadyDecided) {
    console.log(`⚠️  This request is already "${result.status}".`);
    process.exit(0);
  }

  console.log(`\n✅ APPROVED: ${result.summary}`);

  try {
    await executeApproval(approvalId);
    console.log(`📬 Executed and verified.\n`);
    console.log(`ℹ️  Note: actually contacting the platform is still Phase 2 (not built yet) —`);
    console.log(`   this run's "execute" step is the simulated stand-in documented in Executor.js.\n`);
  } catch (error) {
    console.error(`\n❌ Approved, but execution failed: ${error.message}\n`);
  }
}

main();
