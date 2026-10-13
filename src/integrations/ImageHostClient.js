/**
 * Uploads a generated image to imgbb (free, no billing account needed) so it
 * has a public HTTPS URL — Instagram's media container API requires one and
 * will not accept a base64 image or a localhost/private address.
 *
 * Images are kept for 180 days (IMGBB_EXPIRATION_SECONDS below) then
 * auto-delete on imgbb's side — plenty of time for Instagram to have already
 * fetched and stored its own copy during container creation (see
 * InstagramClient.js), so nothing breaks when the imgbb copy expires later.
 */

import axios from "axios";

const IMGBB_API = "https://api.imgbb.com/1/upload";
const IMGBB_EXPIRATION_SECONDS = 15552000; // 180 days — imgbb's max

function requireKey() {
const key = process.env.IMGBB_API_KEY;
if (!key) {
throw new Error(
"IMGBB_API_KEY is not set. Get a free key (no card needed) at https://api.imgbb.com/ and add it to .env — see docs/INSTAGRAM_SETUP.md."
);
}
return key;
}

/**
 * `imageBase64` is the raw base64 payload (no "data:image/jpeg;base64," prefix).
 * Returns the direct, hotlinkable image URL (data.url — NOT url_viewer, which
 * is a human-facing page, not a raw image Instagram's fetcher can read).
 */
export async function uploadImage(imageBase64, filename = "post", { permanent = false } = {}) {
const params = new URLSearchParams();
params.append("key", requireKey());
params.append("image", Buffer.isBuffer(imageBase64) ? imageBase64.toString("base64") : imageBase64);
params.append("name", filename);
// Brand-library assets (real app screenshots) are reused for months, so
// they're stored with no expiration. Per-post images keep the 180-day TTL.
if (!permanent) params.append("expiration", String(IMGBB_EXPIRATION_SECONDS));

const { data } = await axios.post(IMGBB_API, params);

if (!data?.success || !data?.data?.url) {
throw new Error(`imgbb upload failed: ${JSON.stringify(data?.error || data)}`);
}

return data.data.url;
}

/** Downloads an image from a public URL (e.g. a brand-library asset) as a Buffer. */
export async function downloadImage(url) {
const { data } = await axios.get(url, { responseType: "arraybuffer" });
return Buffer.from(data);
}
