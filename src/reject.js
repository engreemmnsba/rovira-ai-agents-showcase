import "dotenv/config";
import { decideApproval } from "./core/ApprovalGate.js";

const [, , approvalId, ...reasonParts] = process.argv;
const reason = reasonParts.join(" ");

if (!approvalId) {
  console.log('Usage: node src/reject.js <approvalId> "reason"');
  process.exit(1);
}

async function main() {
  const result = await decideApproval(approvalId, "reject", { reason });

  if (result.alreadyDecided) {
    console.log(`⚠️  This request is already "${result.status}".`);
    process.exit(0);
  }

  console.log(`\n🚫 REJECTED: ${result.summary}`);
  console.log(`   No execution will happen for this request.\n`);
}

main();
