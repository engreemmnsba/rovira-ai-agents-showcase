/**
 * Publishes a photo post to the Rovira Facebook page. Called ONLY from
 * Executor.js, right after an approved Instagram post goes live — the same
 * human approval covers both channels. Nothing else in the codebase can
 * reach the page.
 *
 * Env: FB_PAGE_ID, FB_PAGE_TOKEN (a long-lived PAGE access token with
 * pages_manage_posts — see docs/WHATSAPP_SAAD.md, "Facebook page token").
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export function isFacebookPageConfigured() {
  return Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN);
}

export async function publishPagePhoto(imageUrl, caption) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) throw new Error("FB_PAGE_ID / FB_PAGE_TOKEN not set in .env");

  const body = new URLSearchParams({ url: imageUrl, caption, access_token: FB_PAGE_TOKEN, published: "true" });
  const res = await fetch(`${GRAPH}/${FB_PAGE_ID}/photos`, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !(data.post_id || data.id)) {
    throw new Error(data?.error?.message || `Facebook publish failed (HTTP ${res.status})`);
  }
  return { postId: data.post_id || data.id };
}
