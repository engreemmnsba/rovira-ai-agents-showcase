import "dotenv/config";
import LinkedInContentAgent from "./agents/LinkedInContentAgent.js";

/**
 * Manual trigger — draft one LinkedIn post right now, outside the Mon/Wed/Fri
 * schedule. Usage:
 *
 *   node src/draft-linkedin-post.js
 *   node src/draft-linkedin-post.js "write about how I handle multi-tenant data isolation in دفتري"
 *
 * With no idea given, it falls back to the queued contentIdeas (see
 * src/add-content-idea.js), then to a random real project — same fallback
 * order the scheduled run uses. This only creates a WAITING_APPROVAL draft;
 * nothing gets posted until you run src/approve.js on it.
 */
const idea = process.argv.slice(2).join(" ").trim() || null;

const agent = new LinkedInContentAgent();
const approvalId = await agent.run(idea);

if (approvalId) {
  console.log(`\n✅ Draft created and waiting for your approval.`);
  console.log(`   Review it: node src/list-approvals.js`);
  console.log(`   Approve:   node src/approve.js ${approvalId}`);
  console.log(`   Reject:    node src/reject.js ${approvalId} "reason"`);
} else {
  console.log(
    "\nℹ️  No new draft created — a previous draft is probably still waiting for your approval. Check: node src/list-approvals.js"
  );
}

process.exit(0);
