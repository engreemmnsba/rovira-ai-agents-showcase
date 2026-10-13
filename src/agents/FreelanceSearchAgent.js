import Agent from "../core/Agent.js";
import { requestApproval } from "../core/ApprovalGate.js";
import { createOpportunity, getOpportunityByExternalId, getUserProfile } from "../database/operations.js";
import { searchActiveProjects } from "../integrations/FreelancerClient.js";
import { draftProposal as draftProposalWithClaude } from "../integrations/ClaudeClient.js";

// Skills from Reem's profile — used as search terms against each platform.
const SEARCH_TERMS = ["Flutter", "ASP.NET Core", "Firebase", "SQL Server", "Docker", "DigitalOcean", "Cloudflare"];

// Platforms with a LIVE integration wired up. Others (Mostaql, Khamsat,
// Upwork, Fiverr, People Per Hour) are still pending — see
// docs/FREELANCER_SETUP.md for why Freelancer.com went first.
const LIVE_PLATFORMS = ["Freelancer.com"];
const PENDING_PLATFORMS = ["Mostaql", "Khamsat", "Upwork", "Fiverr", "People Per Hour"];

// Minimum number of Reem's own skills (from her Firestore profile) that
// must literally appear in a project's title/description before a Claude
// call is spent drafting a proposal for it. Deliberately an absolute count,
// not a percentage of her whole skill list (7 skills → needing 4+ matched
// for a 50% score is basically impossible for a normal job post that only
// mentions 1-2 technologies — a percentage-of-total threshold would filter
// out almost everything, including strong matches). Agreed with Reem
// 2026-09-29: below this bar, she doesn't want to see it at all — no
// Claude call, no Firestore record, no approval request, not even a
// "watch only" entry.
const MIN_MATCHED_SKILLS = 2;

export default class FreelanceSearchAgent extends Agent {
  constructor() {
    super({
      id: "freelance-search",
      name: "Freelance Search Agent",
      cronSchedule: "*/5 * * * *" // every 5 minutes, 24/7 — near-real-time without hammering the platform's API
    });
    this._profileCache = null; // fetched once, reused for the rest of this run
  }

  async run() {
    console.log(`🔍 [${this.name}] Searching ${LIVE_PLATFORMS.join(", ")} (${PENDING_PLATFORMS.join(", ")} not connected yet)...`);

    const found = await this.searchPlatforms(); // INTERNAL — read-only

    if (found.length === 0) {
      console.log("   No new opportunities this run.");
      return;
    }

    const profile = await this._getProfile();
    let queued = 0;
    let skippedLowFit = 0;

    for (const opportunity of found) {
      // Don't re-queue something we've already seen on a previous run.
      const existing = await getOpportunityByExternalId(opportunity.platform, opportunity.externalId);
      if (existing) continue;

      // Cheap, free, rule-based pre-check — skip anything below the fit
      // bar BEFORE spending a Claude call on it. Nothing is created for a
      // skipped opportunity (no Firestore record, no approval, no alert).
      const preCheck = this.analyzeOpportunity(opportunity, profile);
      if (preCheck.matchedSkills.length < MIN_MATCHED_SKILLS) {
        console.log(`   ⏭️  Skipped (low fit — ${preCheck.matchedSkills.length}/${MIN_MATCHED_SKILLS} skills matched): "${opportunity.title}"`);
        skippedLowFit++;
        continue;
      }

      const { opportunityId } = await this.processOpportunity(opportunity);
      console.log(`   📋 Queued for approval: "${opportunity.title}" (${opportunity.platform}) — opportunityId: ${opportunityId}`);
      queued++;
    }

    if (queued === 0 && skippedLowFit === 0) {
      console.log("   Found projects, but all were already queued/decided in a previous run.");
    } else if (queued === 0) {
      console.log(`   No new opportunity matched well enough this run (skipped ${skippedLowFit} low-fit project(s)).`);
    }
  }

  /**
   * The full internal pipeline for one opportunity: ANALYZE → PREPARE →
   * WAITING_APPROVAL. Pulled out of run() so both the real search loop and
   * the approval-flow test harness can drive it with a single opportunity.
   */
  async processOpportunity(opportunity) {
    const profile = await this._getProfile();
    const analysis = this.analyzeOpportunity(opportunity, profile); // INTERNAL
    const proposal = await this.draftProposal(opportunity, analysis, profile); // INTERNAL — drafts only, never sends

    // INTERNAL — writing our own record, not a commercial action
    const opportunityId = await createOpportunity({
      ...opportunity,
      analysis,
      proposal,
      approvalStatus: "WAITING_APPROVAL"
    });

    // GATED — the only bridge between "drafted" and "sent". Creates a
    // WAITING_APPROVAL request and returns; does not send anything itself.
    // NOTE: actually submitting a bid via the Freelancer.com API is on hold
    // until api-support@freelancer.com responds (see docs/FREELANCER_SETUP.md)
    // — approving this right now still means YOU submit it manually.
    const approvalId = await requestApproval({
      agentId: this.id,
      actionType: "SEND_PROPOSAL",
      summary: `فرصة جديدة على ${opportunity.platform}: "${opportunity.title}" — العرض جاهز وبانتظار موافقتك.`,
      payload: {
        opportunityId,
        platform: opportunity.platform,
        link: opportunity.link,
        proposal
      }
    });

    return { opportunityId, approvalId, analysis, proposal };
  }

  /**
   * LIVE for Freelancer.com (read-only "Search for Active Projects" —
   * the officially-allowed "Work Sourcer" integration type). Still a stub
   * for every other platform until each one is connected.
   */
  async searchPlatforms() {
    const results = [];

    if (!process.env.FREELANCER_API_TOKEN) {
      console.log("   ⏭️  Freelancer.com: FREELANCER_API_TOKEN not set yet — see docs/FREELANCER_SETUP.md");
    } else {
      const seen = new Map();
      for (const term of SEARCH_TERMS) {
        try {
          const projects = await searchActiveProjects(term, { limit: 10 });
          for (const p of projects) {
            if (seen.has(p.id)) continue;
            seen.set(p.id, {
              title: p.title,
              platform: "Freelancer.com",
              externalId: p.id,
              link: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
              description: p.preview_description || ""
            });
          }
        } catch (error) {
          console.error(`   ⚠️  Freelancer.com search failed for "${term}":`, error.message);
        }
      }
      results.push(...seen.values());
    }

    // Mostaql/Khamsat/Upwork/Fiverr/People Per Hour: not connected yet.
    return results;
  }

  /**
   * Weighs the opportunity's title+description against Reem's real skill
   * stack (from her Firestore profile — falls back to SEARCH_TERMS if the
   * profile has none yet), and flags anything worth a second look before
   * she approves. Rule-based on purpose: fast, free, and the flags feed
   * straight into the proposal prompt so it can write around them.
   */
  analyzeOpportunity(opportunity, profile) {
    const skills = profile?.skills?.length ? profile.skills : SEARCH_TERMS;
    const text = `${opportunity.title} ${opportunity.description || ""}`.toLowerCase();

    const matchedSkills = skills.filter(skill => text.includes(skill.toLowerCase()));
    const fitScore = skills.length ? Math.round((matchedSkills.length / skills.length) * 100) : 0;

    const flags = [];
    if (matchedSkills.length === 0) {
      flags.push("No listed skill keyword matched the title/description — check it's a real fit before approving.");
    }
    if (!opportunity.description || opportunity.description.trim().length < 40) {
      flags.push("Description is short or missing from the search results — open the listing on the platform before approving.");
    }

    return {
      fitScore,
      matchedSkills,
      flags,
      fitNotes: matchedSkills.length
        ? `Matches: ${matchedSkills.join(", ")}`
        : "No direct skill match found in the title/description."
    };
  }

  /**
   * Real drafting via the Claude API (replaces the old placeholder). Always
   * a draft only — never sent by this function, only ever queued for
   * approval. If the API call fails for any reason, the opportunity is
   * still queued with a clear fallback note so one bad call never blocks
   * the whole run.
   */
  async draftProposal(opportunity, analysis, profile) {
    try {
      return await draftProposalWithClaude({ opportunity, analysis, profile });
    } catch (error) {
      console.error(`   ⚠️  Proposal drafting failed for "${opportunity.title}":`, error.message);
      return `⚠️ Proposal drafting failed (${error.message}). Draft this one manually before approving.\n\nProject: ${opportunity.title}\n${opportunity.link}`;
    }
  }

  /** Fetches Reem's profile once per run and reuses it for every opportunity. */
  async _getProfile() {
    if (!this._profileCache) {
      this._profileCache = await getUserProfile();
    }
    return this._profileCache;
  }
}
