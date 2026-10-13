/**
 * OpenAI image generation (gpt-image-1) — turns a text prompt into a real
 * JPEG image. Output format is forced to jpeg because Instagram's content
 * publishing API only accepts JPEG (see InstagramClient.js).
 *
 * gpt-image-1 always returns base64 image data, never a URL — there is no
 * "give me a hosted link" option on this endpoint, which is exactly why
 * ImageHostClient.js exists (Instagram needs a public URL, not base64).
 */

import axios from "axios";

const OPENAI_API = "https://api.openai.com/v1/images/generations";

function requireKey() {
const key = process.env.OPENAI_API_KEY;
if (!key) {
throw new Error(
"OPENAI_API_KEY is not set. Get one at https://platform.openai.com/api-keys and add it to .env — see docs/INSTAGRAM_SETUP.md."
);
}
return key;
}

/**
 * Returns raw base64 JPEG data (no "data:image/jpeg;base64," prefix) — pass
 * it straight into ImageHostClient.uploadImage().
 */
export async function generateImage(prompt, { size = "1024x1024", quality = "high" } = {}) {
const { data } = await axios
.post(
OPENAI_API,
{
model: "gpt-image-1",
prompt,
size,
quality,
output_format: "jpeg",
n: 1
},
{
headers: {
Authorization: `Bearer ${requireKey()}`,
"Content-Type": "application/json"
}
}
)
.catch(error => {
// Surface OpenAI's own reason (billing, safety, bad size...) instead of axios's generic "status code 400".
throw new Error(`OpenAI image: ${error.response?.data?.error?.message || error.message}`);
});

const image = data?.data?.[0];
if (!image?.b64_json) {
throw new Error(`OpenAI image generation returned no image data: ${JSON.stringify(data)}`);
}

return image.b64_json;
}

/**
 * Same output as generateImage, but anchored on reference photos (Rovira's
 * fixed office and presenter) via OpenAI's images/edits endpoint, so every
 * scene happens in the same place with the same person. `references` are
 * Buffers (JPEG/PNG). Falls back to plain generation when there are none.
 */
export async function generateImageWithReferences(prompt, references = [], { size = "1024x1536", quality = "high" } = {}) {
if (!references.length) return generateImage(prompt, { size, quality });

const form = new FormData();
form.append("model", "gpt-image-1");
form.append("prompt", prompt);
form.append("size", size);
form.append("quality", quality);
form.append("output_format", "jpeg");
form.append("input_fidelity", "high"); // keep the face / room close to the references
form.append("n", "1");
references.forEach((buf, i) => form.append("image[]", new Blob([buf], { type: "image/jpeg" }), `ref-${i}.jpg`));

const res = await fetch("https://api.openai.com/v1/images/edits", {
method: "POST",
headers: { Authorization: `Bearer ${requireKey()}` },
body: form
});
const data = await res.json().catch(() => ({}));
const image = data?.data?.[0];
if (!res.ok || !image?.b64_json) {
throw new Error(`OpenAI reference image generation failed: ${data?.error?.message || `HTTP ${res.status}`}`);
}
return image.b64_json;
}
