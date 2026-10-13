import { db } from "../config/firebase.js";

/**
 * The shared brand kit every content agent reads before making anything —
 * LinkedIn and Instagram today, Reels later. Two parts:
 *
 * 1. Brand identity (brandKit/identity in Firestore): who Rovira talks to,
 *    how it sounds, and the fixed rules for imagery. Editable by Reem from
 *    Telegram (set_brand_identity) — full-replace, like AgentInstructions.
 *    Until she sets one, DEFAULT_BRAND_IDENTITY below is used.
 *
 * 2. Asset library (brandAssets collection): REAL screenshots / photos of
 *    Rovira's own apps, added by Reem from Telegram (send a photo with a
 *    caption like "دفتري - دفتر الديون"). Agents show these inside a device
 *    frame instead of letting an image model invent a fake app UI.
 *
 * BRAND (colors/fonts) is the visual system the PostComposer draws with.
 * It mirrors the Rovira design system and changes only with a code change,
 * on purpose — the look shouldn't drift because of a chat message.
 *
 * Read fresh on every call, no cache — same reasoning as
 * AgentInstructions.js (these agents run a few times a week).
 */

export const BRAND = {
  colors: {
    deep: "#0B3D4A",
    teal: "#0F4C5C",
    spark: "#E8A33D",
    sparkInk: "#8A5410",
    sand: "#F4EEE3",
    ink: "#10181B",
    muted: "#4A5558",
    mist: "#DCE7E8"
  },
  fonts: { arabic: "Readex Pro", latin: "Manrope" },
  website: "rovira.dev"
};

// Example only — the real identity lives in Firestore (brandKit/identity)
// and is not part of this public showcase.
export const DEFAULT_BRAND_IDENTITY = `Identity: <Studio name> — a small software studio.
Audience: owners of small and mid-sized businesses.
Services: workflow automation, AI agents, and custom apps.
Voice: clear and friendly. Start with the customer's problem, show the result, end with one call to action. No hype, no invented numbers, no promises about prices or dates.
On-image text: a short headline (2-6 words), rendered in code — never by the image model.
Imagery: app screens are always real screenshots from the asset library. AI images are scenes and backgrounds only — no text, logos, or app UI.`;

/** Formula every AI image prompt follows (from Reem's prompt-builder tool). */
export const IMAGE_PROMPT_FORMULA = `Write the imagePrompt in English following this exact order:
subject + action + environment. Composition: (keep the TOP 40% of the frame calm and uncluttered). Lighting: (warm, natural, soft). Style: (clean editorial photography OR flat geometric illustration — pick one). Camera: (lens/angle if photographic). Color palette: deep teal blue #0B3D4A, teal #0F4C5C, warm sand #F4EEE3, a small saffron #E8A33D accent. Mood: calm, capable, optimistic. Avoid: any text, letters, numbers, logos, watermarks, app UI, screens with readable content, neon, purple-blue gradients, glowing brains, binary code, cartoon robots. Portrait 2:3.`;

export async function getBrandIdentity() {
  const doc = await db.collection("brandKit").doc("identity").get();
  const text = doc.exists ? doc.data().text : null;
  return text || DEFAULT_BRAND_IDENTITY;
}

export async function setBrandIdentity(text) {
  await db.collection("brandKit").doc("identity").set({ text, updatedAt: new Date() });
}

/**
 * The fixed "set" every AI scene happens in, so posts and (later) Reels
 * look like one company, not random stock: one office, one presenter.
 * The text below is used in every scene prompt; the REAL look is locked by
 * reference images Reem sends from Telegram with the caption "مكان" or
 * "شخصية" (kind "place" / "character" in brandAssets) — those are passed
 * to the image model as references (ImageGenClient, images/edits).
 */
// Example only — the real scene descriptions are not part of this showcase.
export const SCENE_BIBLE = {
  place:
    "<Studio office>: a calm, modern workspace in the brand colors, natural warm light. Device screens show only abstract brand-colored shapes — never readable UI or text.",
  character:
    "<Presenter>: one consistent person described once here, so the same face and outfit appear in every image."
};

/** Caption words that mark a photo as a scene reference, not a screenshot. */
const KIND_WORDS = {
  place: ["مكان", "المكان", "المكتب", "place", "office"],
  character: ["شخصية", "الشخصية", "character", "presenter"]
};

/**
 * Parses a Telegram caption like "دفتري - دفتر الديون" or
 * "Cafi – شاشة الطلبات #pos #كاشير" into { app, feature, tags }.
 */
export function parseAssetCaption(caption = "") {
  const tags = (caption.match(/#[^\s#]+/g) || []).map(t => t.slice(1));
  const clean = caption.replace(/#[^\s#]+/g, "").trim();
  const [app, ...rest] = clean.split(/\s[-–—|]\s/);
  const appName = (app || "").trim() || "عام";
  const kind = Object.keys(KIND_WORDS).find(k => KIND_WORDS[k].includes(appName.toLowerCase())) || "screenshot";
  return {
    app: appName,
    feature: rest.join(" - ").trim() || null,
    tags,
    kind
  };
}

export async function addBrandAsset({ url, app, feature = null, kind = "screenshot", tags = [], width = null, height = null, telegramFileId = null }) {
  const ref = await db.collection("brandAssets").add({
    url,
    app,
    feature,
    kind, // "screenshot" | "photo" | "logo" | "video" (videos: for Reels later)
    tags,
    width,
    height,
    telegramFileId,
    active: true,
    usedCount: 0,
    createdAt: new Date()
  });
  return ref.id;
}

export async function listBrandAssets({ kind = null, app = null } = {}) {
  const snap = await db.collection("brandAssets").where("active", "==", true).get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(a => (!kind || a.kind === kind) && (!app || a.app === app))
    .sort((a, b) => (a.usedCount || 0) - (b.usedCount || 0));
}

export async function getBrandAsset(id) {
  const doc = await db.collection("brandAssets").doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function markBrandAssetUsed(id) {
  try {
    const ref = db.collection("brandAssets").doc(id);
    const doc = await ref.get();
    if (doc.exists) await ref.update({ usedCount: (doc.data().usedCount || 0) + 1, lastUsedAt: new Date() });
  } catch (error) {
    console.error("Failed to mark brand asset used:", error.message);
  }
}

export async function deactivateBrandAsset(id) {
  await db.collection("brandAssets").doc(id).update({ active: false, updatedAt: new Date() });
}

/**
 * Reference images for AI scenes: the least-used "place" photo, plus the
 * least-used "character" photo when the scene needs the presenter.
 * Returns [] until Reem has sent any — scenes then rely on SCENE_BIBLE text.
 */
export async function getSceneReferences({ withCharacter = false } = {}) {
  const refs = [];
  const [place] = await listBrandAssets({ kind: "place" });
  if (place) refs.push(place);
  if (withCharacter) {
    const [character] = await listBrandAssets({ kind: "character" });
    if (character) refs.push(character);
  }
  return refs;
}

/**
 * Product sheets — one Firestore doc per app (brandProducts/<slug>), the
 * single source of truth for what each app is, who it's for, what it does
 * and what it achieved. Read by every content agent (and later the
 * WhatsApp agent "سعد"), so app facts are written once, never per agent.
 * Reem sends them from Telegram; each send replaces that app's sheet.
 */
export function productSlug(app) {
  return String(app).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "app";
}

export async function setProductInfo(app, info) {
  // merge: keeps the sales card (packages, links, trial) set by ProductSales.js
  await db.collection("brandProducts").doc(productSlug(app)).set({ app: String(app).trim(), info, updatedAt: new Date() }, { merge: true });
}

export async function listProducts() {
  const snap = await db.collection("brandProducts").get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * One ready-to-inject block for any content agent's prompt: the identity
 * plus a compact list of the real screenshots available, so the model can
 * pick one by id instead of describing a fake screen.
 */
export async function getBrandContext({ includeAssets = true, includeProducts = true } = {}) {
  const identity = await getBrandIdentity();
  let block = `هوية العلامة (اتبعيها دايمًا):\n${identity}`;
  if (includeProducts) {
    const products = await listProducts();
    if (products.length > 0) {
      block += `\n\nملفات التطبيقات (الحقائق الوحيدة المسموح تستخدميها عن كل تطبيق — ما تخترعي ميزات أو أرقام مش موجودة هون):\n${products
        .map(p => `### ${p.app}\n${p.info}`)
        .join("\n\n")}`;
    }
  }
  if (includeAssets) {
    const assets = await listBrandAssets({ kind: "screenshot" });
    if (assets.length > 0) {
      block += `\n\nمكتبة الصور الحقيقية المتاحة (id — التطبيق — الميزة):\n${assets
        .slice(0, 40)
        .map(a => `- ${a.id} — ${a.app}${a.feature ? ` — ${a.feature}` : ""}`)
        .join("\n")}`;
    } else {
      block += `\n\nمكتبة الصور الحقيقية: فاضية لسا.`;
    }
  }
  return block;
}
