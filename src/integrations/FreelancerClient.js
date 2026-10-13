import axios from "axios";

/**
 * Thin client for the Freelancer.com API — READ-ONLY. This file only calls
 * GET /projects/0.1/projects/active/, the "Search for Active Projects"
 * endpoint, which requires nothing beyond the "basic" OAuth scope (the
 * scope every Personal Access Token gets automatically — no advanced scope
 * request, no app review).
 *
 * This is deliberately the ONLY thing this file can do. Freelancer.com's
 * own API terms explicitly list "Automatic Bidder" integrations as
 * generally prohibited (see developers.freelancer.com/docs/api-overview/
 * types-of-integrations), with an exception sometimes made for internal
 * single-user tools on request. We emailed api-support@freelancer.com to
 * ask about that before writing any bid-submission code — see
 * docs/FREELANCER_SETUP.md. Until that's resolved, there is no function
 * here that calls the bids endpoint, on purpose.
 */

function baseUrl() {
  return process.env.FREELANCER_ENV === "sandbox"
    ? "https://www.freelancer-sandbox.com/api"
    : "https://www.freelancer.com/api";
}

function client() {
  const token = process.env.FREELANCER_API_TOKEN;
  if (!token) {
    throw new Error(
      "FREELANCER_API_TOKEN is not set. Generate a Personal Access Token at " +
      "https://accounts.freelancer.com/settings/develop and add it to .env — see docs/FREELANCER_SETUP.md."
    );
  }
  return axios.create({
    baseURL: baseUrl(),
    headers: { "freelancer-oauth-v1": token },
    timeout: 15000
  });
}

/**
 * Searches OPEN, biddable projects matching a query term. Read-only.
 * Returns Freelancer.com's raw project objects (caller maps them to our
 * own opportunity shape).
 */
export async function searchActiveProjects(query, { limit = 15 } = {}) {
  const api = client();
  const { data } = await api.get("/projects/0.1/projects/active/", {
    params: {
      query,
      limit,
      sort_field: "time_updated",
      compact: true
    }
  });
  return data?.result?.projects ?? [];
}
