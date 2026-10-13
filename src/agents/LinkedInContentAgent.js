import Agent from "../core/Agent.js";
import { requestApproval } from "../core/ApprovalGate.js";
import { findWaitingDraft } from "../core/DraftGuard.js";
import { db } from "../config/firebase.js";
import { getNextContentIdea, markContentIdeaUsed } from "../core/ContentIdeas.js";
import { HOOK_PLAYBOOK } from "../content/hookPlaybook.js";
import { getAgentInstructions } from "../core/AgentInstructions.js";
import { getCompanyContext } from "../core/CompanyKnowledge.js";
import { listProducts, getBrandContext } from "../core/BrandKit.js";
import Anthropic from "@anthropic-ai/sdk";

const CONTENT_ROTATION = ["project_story", "technical_tip", "founder_journey"];

// Real project catalog — source material for project_story / technical_tip
// drafts. Kept here (not invented per-run) so drafts reference things that
// actually exist.
const PROJECTS = [
  "دفتري (Daftari) — multi-tenant retail POS SaaS",
  "Cafi — café management app",
  "Humanitarian Aid Management System",
  "MyNour — card distribution platform",
  "Electricity Meters Management app",
  "Senseivo — digital studio CMS",
  "Madrasati / camp management apps"
];

const CONTENT_TYPE_BRIEF = {
  project_story:
    "Tell a concrete story about building or shipping a real project — a decision made, a problem solved, a result achieved.",
  technical_tip:
    "Share one specific, useful technical insight or lesson learned — something another developer could actually apply.",
  founder_journey:
    "Reflect on building Rovira as an independent freelance software business — a milestone, a lesson, or an honest moment."
};

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export default class LinkedInContentAgent extends Agent {
  constructor() {
    super({
      id: "linkedin-content",
      name: "LinkedIn Content Agent",
      cronSchedule: "0 9 * * 1,3,5" // Mon/Wed/Fri 9am — matches the existing ~2-3x/week cadence
    });
  }

  /**
   * `manualIdea` lets a human hand this exact run a specific idea/instruction
   * right now (src/draft-linkedin-post.js). Without one, run() pulls the
   * oldest queued idea from `contentIdeas` (added via
   * src/add-content-idea.js — this is what the Mon/Wed/Fri schedule uses);
   * if that queue is empty too, it falls back to a random real project so
   * the pipeline never stalls waiting on input.
   */
  async run(manualIdea = null) {
    // Don't pile up a second draft on top of one you haven't decided on yet.
    const waitingId = await findWaitingDraft("linkedinPosts", this.id);
    if (waitingId) {
      console.log(`📝 [${this.name}] A draft is already waiting for your approval — skipping this run.`);
      return { skipped: `في مسودة لينكدإن لسا مستنية موافقتك (${waitingId}). وافقي عليها أو ارفضيها وبعدين بحضّر وحدة جديدة.` };
    }

    const contentType = await this.pickNextContentType(); // INTERNAL

    let ideaText = manualIdea ? manualIdea.trim() : null;
    let queuedIdeaId = null;
    if (!ideaText) {
      const queued = await getNextContentIdea(); // INTERNAL
      if (queued) {
        ideaText = queued.text;
        queuedIdeaId = queued.id;
      }
    }

    const text = await this.draftPost(contentType, ideaText); // INTERNAL — drafts only, never posts

    // INTERNAL — writing our own record
    const postRef = await db.collection("linkedinPosts").add({
      contentType,
      text,
      sourceIdea: ideaText || null,
      approvalStatus: "WAITING_APPROVAL",
      createdAt: new Date()
    });

    if (queuedIdeaId) await markContentIdeaUsed(queuedIdeaId); // INTERNAL

    // GATED — the only bridge between "drafted" and "published". Creates a
    // WAITING_APPROVAL request; does not post anything itself.
    const approvalId = await requestApproval({
      agentId: this.id,
      actionType: "POST_PUBLIC_CONTENT",
      summary: `مسودة بوست لينكدإن جاهزة (${contentType}) — بانتظار موافقتك على النشر.`,
      payload: {
        postId: postRef.id,
        contentType,
        text
      }
    });

    console.log(`   📋 Draft queued for approval: ${contentType} — postId: ${postRef.id}, approvalId: ${approvalId}`);
    return approvalId;
  }

  /**
   * Rotates project_story → technical_tip → founder_journey based on how
   * many posts this agent has produced so far, so the mix stays balanced
   * without needing separate scheduling logic.
   */
  async pickNextContentType() {
    const countSnap = await db.collection("linkedinPosts").count().get();
    const count = countSnap.data().count;
    return CONTENT_ROTATION[count % CONTENT_ROTATION.length];
  }

  /**
   * REAL — calls the Claude API to actually write the post, grounded in a
   * real project from the catalog above and, when given, Reem's own idea or
   * instruction for this specific post. Picks one opening structure from
   * HOOK_PLAYBOOK per run as inspiration (not a fill-in-the-blank script) so
   * posts don't all open the same way. This only drafts text — nothing here
   * touches LinkedIn; publishing still requires an explicit approval.
   */
  async draftPost(contentType, ideaText) {
    // Prefer the app sheets Reem saved (brandProducts); fall back to the
    // built-in list until she has added any.
    const savedProducts = await listProducts();
    const catalog = savedProducts.length > 0 ? savedProducts.map(p => p.app) : PROJECTS;
    const project = catalog[Math.floor(Math.random() * catalog.length)];
    const hook = HOOK_PLAYBOOK[Math.floor(Math.random() * HOOK_PLAYBOOK.length)];
    const instructions = await getAgentInstructions("linkedin-content");
    const companyContext = await getCompanyContext();
    // Shared brand kit (audience, services, voice) — same source Instagram
    // reads, so both channels say the same thing.
    const brandContext = await getBrandContext({ includeAssets: false });

    const systemPrompt = `You write LinkedIn posts for Reem Mansour (Rovira), a full-stack software engineer and founder of Rovira, a freelance software development business. Her stack: Flutter/Dart, ASP.NET Core, Firebase, SQL Server, Docker, DigitalOcean, Cloudflare. She builds production multi-tenant systems independently, often using AI coding tools.

Voice: first person, direct, confident but not boastful, no corporate fluff, no hype emojis, no "🚀🔥💯" spam — at most one emoji, only if it genuinely fits. Write like an engineer talking to peers, not a marketer.

Format: plain LinkedIn text, 120-220 words, short paragraphs (1-3 lines each), end with 2-4 relevant hashtags on their own line at the very end. No markdown formatting (no #, *, -, no headers).

${instructions ? `\nقواعد وخطة المحتوى الثابتة يلي ريم حددتها — اتبعيها دايمًا:\n${instructions}\n` : ""}
${companyContext ? `\n${companyContext}\n` : ""}

${brandContext}
(LinkedIn is Reem's own voice, first person, so write it in English or Arabic as her instructions say — but follow the audience, services and framing rules above.)

Open the post using this structure as inspiration — adapt it naturally, don't force it or label it: ${hook.name} — ${hook.structure}

This is a "${contentType}" post: ${CONTENT_TYPE_BRIEF[contentType]}

Ground it in this real project when relevant: ${project}${
      ideaText
        ? `\n\nReem's specific instruction/idea for this post: "${ideaText}" — follow this closely, it takes priority over everything else above.`
        : ""
    }

Output ONLY the post text itself — no preamble, no quotes around it, no explanation, nothing else.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: "user", content: "Write the post." }]
    });

    return message.content[0].text.trim();
  }
}
