/**
 * Instagram content-publishing client — uses "Instagram API with Instagram
 * Login" (graph.instagram.com), not the older Facebook-Page-linked flow, so
 * no Facebook Page is required. See docs/INSTAGRAM_SETUP.md and
 * src/instagram-auth.js for how INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID
 * get into .env in the first place.
 *
 * Publishing a single image is a two-step dance:
 *   1. createMediaContainer — Instagram fetches the image_url itself and
 *      stores its own copy, returning a container id. The container is
 *      good for 24h even though the public image_url (imgbb) can — and
 *      usually will — outlive that by months; Instagram doesn't need it
 *      again after this step.
 *   2. publishContainer — turns that container into an actual, live post.
 *
 * This file can only create a container immediately (called from the
 * content agent, right after the image is generated and hosted) and
 * publish one (called from Executor.js, only after a human approval) — it
 * has no other way to reach Instagram.
 */

import axios from "axios";

const API_BASE = "https://graph.instagram.com/v21.0";

function requireEnv(name) {
const value = process.env[name];
if (!value) {
throw new Error(`${name} is not set in .env — see docs/INSTAGRAM_SETUP.md. Run: node src/instagram-auth.js`);
}
return value;
}

/**
 * Creates (but does not publish) a media container for one image + caption.
 * `imageUrl` must be a public, directly-fetchable JPEG URL (ImageHostClient
 * provides this). Returns the container id (Instagram calls it creation_id).
 */
export async function createMediaContainer(imageUrl, caption) {
const igUserId = requireEnv("INSTAGRAM_USER_ID");
const accessToken = requireEnv("INSTAGRAM_ACCESS_TOKEN");

const { data } = await axios.post(`${API_BASE}/${igUserId}/media`, {
image_url: imageUrl,
caption,
access_token: accessToken
});

if (!data?.id) {
throw new Error(`Instagram container creation failed: ${JSON.stringify(data)}`);
}

return data.id;
}

/**
 * The ONLY write action in this file that makes a post actually go live.
 * Called exclusively by Executor.js, and only after a human has approved
 * the exact caption + image that were used to create this container.
 */
export async function publishContainer(creationId) {
const igUserId = requireEnv("INSTAGRAM_USER_ID");
const accessToken = requireEnv("INSTAGRAM_ACCESS_TOKEN");

const { data } = await axios.post(`${API_BASE}/${igUserId}/media_publish`, {
creation_id: creationId,
access_token: accessToken
});

if (!data?.id) {
throw new Error(`Instagram publish failed: ${JSON.stringify(data)}`);
}

return { postId: data.id };
}
