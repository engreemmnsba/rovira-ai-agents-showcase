import "dotenv/config";
import dns from "node:dns";

// api.telegram.org fails to resolve (ENOTFOUND) via Reem's ISP-provided DNS
// but works fine over the browser's own secure DNS — an ISP-level DNS block
// on that one domain, not a real network or code problem. Pointing Node's
// resolver at a public DNS bypasses it; nothing else here depends on this.
dns.setServers(["1.1.1.1", "8.8.8.8"]);

import MasterAgent from "./core/MasterAgent.js";
import FreelanceSearchAgent from "./agents/FreelanceSearchAgent.js";
import LinkedInContentAgent from "./agents/LinkedInContentAgent.js";
import InstagramContentAgent from "./agents/InstagramContentAgent.js";
import { startTelegramBot } from "./telegram/bot.js";
import { startWhatsAppWebhook } from "./whatsapp/webhook.js";

MasterAgent.register(new FreelanceSearchAgent());
MasterAgent.register(new LinkedInContentAgent());
MasterAgent.register(new InstagramContentAgent());

MasterAgent.start();
startTelegramBot(MasterAgent);
startWhatsAppWebhook(); // سعد — no-op until its .env values are set

console.log("✅ Orchestrator running — agents will run on their schedules. Press Ctrl+C to stop.\n");
console.log("ℹ️  Any pending approvals will print here (and on Telegram/WhatsApp once configured).");
console.log("   Review them anytime with: node src/list-approvals.js\n");
