/**
* Central permission matrix.
*
* Hard rule (non-negotiable): every action an agent can take is classified as
* either INTERNAL (safe to run autonomously) or GATED (touches the outside
* world or money — must go through the Approval Gate before anything real
* happens). An action type that is not explicitly listed as INTERNAL is
* treated as GATED by default — deny-by-default, not allow-by-default.
*
* No agent, anywhere in this codebase, is allowed to send a message, submit
* an application, accept a contract, or move money on its own. Those
* "send"/"submit"/"pay" functions simply do not exist yet in this codebase —
* the only thing an agent can do with an external/commercial action is
* request approval for it (see ApprovalGate.js) and wait for a human decision.
*/

// Actions that never touch the outside world or a client/platform directly.
// Safe to run without asking first.
const INTERNAL_ACTIONS = new Set([
"SEARCH",              // read-only search of a platform's public listings
"ANALYZE",             // analyzing an opportunity/client/market internally
"DRAFT_CONTENT",       // drafting a proposal/message/post (not sending it)
"READ_DATA",           // reading Firestore / internal state
"WRITE_INTERNAL_RECORD", // writing our own Firestore records (not external)
"GENERATE_IMAGE",      // generating + hosting an image (not posting it anywhere)
"CREATE_MEDIA_CONTAINER" // Instagram container creation — invisible until published
]);

const GATED_ACTIONS = new Set([
"SEND_PROPOSAL",
"SEND_MESSAGE",
"SUBMIT_APPLICATION",
"POST_PUBLIC_CONTENT",
"POST_INSTAGRAM_CONTENT",
"ACCEPT_CONTRACT",
"MAKE_PAYMENT"
]);

// Per-agent declaration of what it's registered to do. This is documentation
// + a registration guard (MasterAgent refuses to register an agent that
// isn't listed here) — it is NOT what grants autonomy; INTERNAL_ACTIONS is
// what grants autonomy, and GATED_ACTIONS (or anything unlisted) never does.
export const AGENT_PERMISSIONS = {
"freelance-search": {
autonomous: ["SEARCH", "ANALYZE", "DRAFT_CONTENT", "READ_DATA", "WRITE_INTERNAL_RECORD"],
requiresApproval: ["SEND_PROPOSAL", "SUBMIT_APPLICATION"]
},
"linkedin-content": {
autonomous: ["ANALYZE", "DRAFT_CONTENT", "READ_DATA", "WRITE_INTERNAL_RECORD"],
requiresApproval: ["POST_PUBLIC_CONTENT"]
// Connection requests / auto-follow / automated outreach messaging are
// NOT listed here and never will be — LinkedIn's User Agreement bans bot
// automation of those specifically, with no exception for internal
// single-user tools (unlike Freelancer.com's bidding caveat). This
// agent only ever drafts and (with approval) publishes posts.
},
"instagram-content": {
autonomous: ["ANALYZE", "DRAFT_CONTENT", "READ_DATA", "WRITE_INTERNAL_RECORD", "GENERATE_IMAGE", "CREATE_MEDIA_CONTAINER"],
requiresApproval: ["POST_INSTAGRAM_CONTENT"]
// Generating an image and creating an Instagram media container are both
// internal/invisible — nothing is public until POST_INSTAGRAM_CONTENT is
// approved and Executor.js calls publishContainer(). Same shape as the
// LinkedIn agent: draft (+ here, also generate) autonomously, publish
// only with a human decision.
},
"whatsapp-support": {
// "سعد" — answers customers on WhatsApp. Its replies are the ONE scoped
// exception to "nothing external without approval" (Reem approved it
// explicitly on 2026-10-07), and only within SCOPED_AUTONOMOUS_ACTIONS
// below: answers drawn strictly from the brand kit / product sheets /
// company profile, never prices, dates or promises, and everything else
// handed to Reem on Telegram. Any message Reem sends to a customer goes
// out only because she wrote or approved that exact text.
autonomous: ["ANALYZE", "READ_DATA", "WRITE_INTERNAL_RECORD", "REPLY_FROM_KNOWLEDGE"],
requiresApproval: ["SEND_MESSAGE"]
}
// Future agents get registered here as they're built. No GATED action is
// ever marked autonomous; the only autonomous external action in the
// whole system is whatsapp-support's REPLY_FROM_KNOWLEDGE, scoped below.
};

/**
* Narrow, per-agent exceptions Reem approved explicitly. Each entry is one
* agent and the exact action it may take on its own — nothing else, and no
* other agent inherits it. requiresApproval() is unchanged: these actions
* never go through the approval gate at all; they are checked with
* isScopedAutonomous() at the single call site that performs them.
*/
const SCOPED_AUTONOMOUS_ACTIONS = {
"whatsapp-support": new Set(["REPLY_FROM_KNOWLEDGE"])
};

export function isScopedAutonomous(agentId, actionType) {
return SCOPED_AUTONOMOUS_ACTIONS[agentId]?.has(actionType) === true;
}

/**
* Returns whether actionType requires approval before it can be executed.
* Deny-by-default: anything not explicitly in INTERNAL_ACTIONS requires
* approval, whether or not it's in GATED_ACTIONS or even recognized at all.
*/
export function requiresApproval(actionType) {
return !INTERNAL_ACTIONS.has(actionType);
}

export function isRegisteredAgent(agentId) {
return Object.prototype.hasOwnProperty.call(AGENT_PERMISSIONS, agentId);
}
