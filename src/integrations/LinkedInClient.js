import axios from "axios";
import fs from "fs";
import path from "path";

/**
 * LinkedIn API client — uses only the officially self-serve "Share on
 * LinkedIn" product (w_member_social scope). This file can read the
 * authenticated member's own profile and publish a text post on their
 * behalf. It deliberately has NO function for connection requests, follows,
 * or messaging — LinkedIn's User Agreement bans automating those, with no
 * carve-out for internal tools. See docs/LINKEDIN_SETUP.md.
 */

const API_BASE = "https://api.linkedin.com";
const LINKEDIN_VERSION = "202601"; // YYYYMM, bump periodically per LinkedIn's versioning docs

function envPath() {
  return path.join(process.cwd(), ".env");
}

/**
 * Access tokens last ~60 days. Rather than build a full refresh-token
 * rotation flow (LinkedIn refresh tokens need periodic re-auth anyway),
 * this just fails clearly and tells you to re-run linkedin-auth.js when
 * the stored token has expired. Simple and honest beats a fragile
 * auto-refresh loop for a single-user tool.
 */
function getAccessToken() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const expiresAt = process.env.LINKEDIN_TOKEN_EXPIRES_AT;

  if (!token) {
    throw new Error("LINKEDIN_ACCESS_TOKEN is not set. Run: node src/linkedin-auth.js (see docs/LINKEDIN_SETUP.md).");
  }
  if (expiresAt && Date.now() > Number(expiresAt)) {
    throw new Error("Your LinkedIn access token has expired. Run: node src/linkedin-auth.js to reauthorize.");
  }
  return token;
}

function client() {
  return axios.create({
    baseURL: API_BASE,
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": LINKEDIN_VERSION,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });
}

/**
 * Returns the authenticated member's own info, including their LinkedIn
 * member ID (used to build the "urn:li:person:{id}" author field a post
 * requires). Requires the "openid profile" scopes.
 */
export async function getUserInfo() {
  const { data } = await client().get("/v2/userinfo");
  return data; // { sub, name, given_name, family_name, picture, ... }
}

/**
 * Publishes a text post to the authenticated member's own profile.
 * This is the ONLY write action in this file. Called exclusively by
 * Executor.js, and only after a human has approved the exact text.
 */
export async function createTextPost({ personUrn, text, visibility = "PUBLIC" }) {
  const { data, headers } = await client().post("/rest/posts", {
    author: personUrn,
    commentary: text,
    visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  });

  const postId = headers["x-restli-id"] || data?.id || null;
  return { postId };
}

/**
 * Reads the LINKEDIN_PERSON_URN saved to .env by linkedin-auth.js, so
 * callers don't need to fetch userinfo on every post.
 */
export function getStoredPersonUrn() {
  const urn = process.env.LINKEDIN_PERSON_URN;
  if (!urn) {
    throw new Error("LINKEDIN_PERSON_URN is not set. Run: node src/linkedin-auth.js.");
  }
  return urn;
}
