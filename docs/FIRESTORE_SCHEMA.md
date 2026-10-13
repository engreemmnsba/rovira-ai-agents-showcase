# Firestore Schema — Rovira AI Workforce

## Implemented now (Phase 1 — Master Agent + Freelance Search Agent)

### `agents`
Not yet written to Firestore — the permission matrix currently lives in code
(`src/core/Permissions.js`) so it can't drift from what's actually enforced.
If/when agents need to be paused or reconfigured without a redeploy, this
becomes a real collection mirroring that file.

### `tasks`
One document per agent run.
- `agentId` (string)
- `status`: `"running"` | `"completed"` | `"failed"`
- `createdAt`, `startedAt`, `completedAt` (timestamp)
- `error` (string | null)

### `approvals` — the Approval Gate queue
One document per action an agent wants a human decision on. Nothing in this
codebase can move a document here past `WAITING_APPROVAL` except a human
decision (`src/approve.js` / `src/reject.js`, run by Reem), and nothing can
move an `APPROVED` document to `EXECUTED` except `src/core/Executor.js`,
which re-checks `APPROVED` itself before doing anything.

Lifecycle: `WAITING_APPROVAL` → `APPROVED` → `EXECUTED` (auto-verified) ,
or `WAITING_APPROVAL` → `REJECTED` (dead end — nothing executes).

- `agentId` (string)
- `actionType`: `"SEND_PROPOSAL"` | `"SEND_MESSAGE"` | `"SUBMIT_APPLICATION"` | `"POST_PUBLIC_CONTENT"` | `"ACCEPT_CONTRACT"` | `"MAKE_PAYMENT"`
- `summary` (string — human-readable, this is what gets read out over WhatsApp once Phase 3 wires that up)
- `payload` (object — everything needed to actually execute the action once approved)
- `status`: `"WAITING_APPROVAL"` | `"APPROVED"` | `"REJECTED"` | `"EXECUTED"`
- `requestedAt`, `decidedAt`, `executedAt` (timestamp), `decidedBy` (string | null), `decisionNote` (string | null)

### `auditLog` — append-only
Every attempted/blocked/approved/rejected/executed/verified/failed action,
from every agent and from every human decision. Nothing in this codebase
updates or deletes a document here, including test runs.
- `actorType`: `"agent"` | `"user"` | `"system"`
- `agentId` (string | null)
- `action` (actionType)
- `status`: `"BLOCKED_PENDING_APPROVAL"` | `"APPROVED"` | `"REJECTED"` | `"BLOCKED_NOT_APPROVED"` | `"BLOCKED_NO_EXECUTOR"` | `"EXECUTED"` | `"VERIFIED"` | `"FAILED"`
- `details` (string)
- `relatedApprovalId`, `relatedTaskId` (string | null)
- `timestamp`

### `opportunities` (from Phase 0, extended)
- existing fields, plus:
- `analysis` (object — fit notes/flags from `analyzeOpportunity`)
- `proposal` (string — drafted proposal text)
- `approvalStatus`: `"WAITING_APPROVAL"` | mirrors the linked `approvals` doc once decided/executed

### `userProfile`, `logs`
Unchanged from Phase 0.

### `linkedinPosts` (LinkedIn Content Agent)
- `contentType`: `"project_story"` | `"technical_tip"` | `"founder_journey"`
- `text` (string — drafted via the Claude API in `draftPost()`, grounded in a
  real project and, when given, a specific idea)
- `sourceIdea` (string | null — the idea/instruction this draft was written
  from, whether given manually via `draft-linkedin-post.js` or pulled from
  the `contentIdeas` queue; `null` when it fell back to a random project)
- `approvalStatus`: `"WAITING_APPROVAL"` | mirrors the linked `approvals` doc once decided/executed
- `linkedinPostId` (string | null — set once actually published)
- `createdAt`, `executedAt` (timestamp)

### `contentIdeas` (LinkedIn Content Agent — idea queue)
A simple FIFO queue Reem adds to ahead of time (`src/add-content-idea.js`)
so scheduled drafts aren't limited to the random project rotation. Used
oldest-first, once each; a manual idea passed directly to
`draft-linkedin-post.js` skips this queue entirely.
- `text` (string)
- `used` (boolean)
- `createdAt`, `usedAt` (timestamp)

Note: `getNextContentIdea()` filters `used == false` and orders by
`createdAt` — same shape as the `opportunities` compound query, so it may
ask Firestore for a composite index the first time it runs. If so, open the
console link the error prints and wait for it to finish building, same as
before.

## Planned, not yet built (added as each agent comes online)
`clients`, `projects`, `conversations`, `marketResearch`, `decisions`,
`reports`, `integrations` — these belong to the Social Media Manager,
WhatsApp Support, Market Researcher, Project Analyst, Marketing Strategist,
and CRM Manager agents respectively. Each gets its schema defined in this
file when that agent is actually built, not before.

## The one rule that doesn't change
An action type not listed in `INTERNAL_ACTIONS` in `src/core/Permissions.js`
requires approval — including any new action type nobody has thought of yet.
Deny-by-default, enforced in code, not just documented here.
