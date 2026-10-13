import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper around the Claude API. Used to DRAFT content only (right now:
 * freelance proposals) — never to send, submit, or publish anything. Every
 * string this returns is a draft that still goes through ApprovalGate.js.
 */

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.");
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// Override with ANTHROPIC_MODEL in .env if you want to pin a different one.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/**
 * Drafts a freelance proposal for one opportunity, in Reem's voice.
 *
 * Confirmed format, enforced in the system prompt below:
 *   1) the client's actual problem/goal (no greeting, no filler)
 *   2) how she'd build it — only real tech from her own stack that fits
 *   3) the concrete outcome the client gets
 *   4) one short line inviting a reply
 * Hard rule: never mentions price or a delivery date — those are Reem's
 * calls, made separately, never drafted here.
 */
export async function draftProposal({ opportunity, analysis, profile }) {
  const anthropic = getClient();

  const skills = (profile?.skills || []).join(", ") || "Flutter, ASP.NET Core, Firebase, SQL Server, Docker, DigitalOcean, Cloudflare";
  const matched = (analysis?.matchedSkills || []).join(", ") || "none detected automatically — read the listing before relying on this";
  const flags = (analysis?.flags || []).length
    ? analysis.flags.map(f => `- ${f}`).join("\n")
    : "- none";

  const system = `You write short, direct freelance proposals for Reem Mansour, a full-stack software engineer (${skills}). Voice: human, confident, value-focused — never generic, never salesy, never AI-sounding, never uses placeholders.

Write exactly four short parts, in this order, nothing else:
1. One sentence naming the client's actual problem or goal, drawn from the listing itself.
2. Two to three sentences on how she'd build it — name only the technologies from her stack that genuinely fit this specific project. Don't list her whole stack if it doesn't all apply.
3. One sentence on the concrete outcome/result the client gets.
4. One short closing line inviting a reply — no "Best regards", no signature, no name.

Hard rules: never mention price, budget, or a delivery date. Never say "I read your project description carefully" or similar filler. Output only the proposal text, nothing else — no headers, no labels.`;

  const userMessage = `Platform: ${opportunity.platform}
Project title: ${opportunity.title}
Project description: ${opportunity.description || "(no description text was returned by the search — write generally around the title, and keep part 2 short)"}

Skills that matched this project automatically: ${matched}
Notes (context only — don't mention these explicitly in the proposal):
${flags}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: userMessage }]
  });

  const text = response.content
    ?.filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Claude returned no proposal text.");
  }

  return text;
}

/**
 * Generic one-turn wrapper around the Claude Messages API, with tool-use
 * support — this is what powers the Telegram bot's free-text conversation
 * (src/telegram/bot.js). Unlike draftProposal above, this function has no
 * opinion about content: the caller supplies the full system prompt, tool
 * schema, and message history, and gets the raw Anthropic response back
 * (including tool_use blocks, if any) for the caller's own loop to handle.
 *
 * This function never executes a tool itself and never touches
 * ApprovalGate.js/Executor.js — it only talks to the Claude API. Whatever
 * calls it is responsible for actually running any tool the model asks for
 * and for enforcing the safety rules (that's done in bot.js's executeTool()
 * + the hard constraints written into its SYSTEM_PROMPT).
 */
export async function chatTurn({ system, tools, messages, maxTokens = 1024 }) {
  const anthropic = getClient();

  return anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    tools,
    messages
  });
}
