/**
 * A small library of proven LinkedIn opening-line structures, distilled from
 * general copywriting/marketing research (not scraped from LinkedIn itself —
 * see docs/LINKEDIN_SETUP.md for why). LinkedInContentAgent.draftPost() picks
 * one per run and hands it to the model as inspiration for the opening line,
 * not as a script to fill in — the model still writes the actual sentence.
 */
export const HOOK_PLAYBOOK = [
  {
    name: "Before/After",
    structure:
      "Open by contrasting a rough starting state with where things ended up, in one or two short lines, before explaining how."
  },
  {
    name: "The Confession",
    structure:
      "Open with an honest, slightly vulnerable admission — a mistake, a doubt, a moment of struggle — before pivoting to what came from it."
  },
  {
    name: "The Specific Number",
    structure:
      "Lead with one precise, concrete number (a timeframe, a count, a metric) instead of a vague claim."
  },
  {
    name: "The Direct Question",
    structure:
      "Open with a short question that names a problem the reader (another developer or founder) likely recognizes in themselves."
  },
  {
    name: "The Contrarian Take",
    structure:
      "Open by pushing back on a common assumption in software or freelancing, then justify it with what actually happened."
  },
  {
    name: "The One-Line Scene",
    structure:
      "Drop the reader into a specific, concrete moment (a bug at 2am, a client call, a deploy that failed) before zooming out to the lesson."
  },
  {
    name: "Mistakes To Avoid",
    structure:
      "Open by naming a mistake plainly, as something you did or see others do, before explaining the better way."
  },
  {
    name: "The Simple Promise",
    structure:
      "Open with a plain statement of what the reader will walk away knowing or able to do after reading."
  }
];
