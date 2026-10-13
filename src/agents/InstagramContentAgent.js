import Agent from "../core/Agent.js";
import { requestApproval } from "../core/ApprovalGate.js";
import { findWaitingDraft } from "../core/DraftGuard.js";
import { db } from "../config/firebase.js";
import { getAgentInstructions } from "../core/AgentInstructions.js";
import { getCompanyContext } from "../core/CompanyKnowledge.js";
import { listProducts, getBrandContext, getBrandAsset, markBrandAssetUsed, getSceneReferences, IMAGE_PROMPT_FORMULA, SCENE_BIBLE } from "../core/BrandKit.js";
import { generateImageWithReferences } from "../integrations/ImageGenClient.js";
import { uploadImage, downloadImage } from "../integrations/ImageHostClient.js";
import { composeSceneCard, composeScreenshotCard } from "../integrations/PostComposer.js";
import { createMediaContainer } from "../integrations/InstagramClient.js";
import { sendTelegramPhoto } from "../integrations/TelegramClient.js";
import Anthropic from "@anthropic-ai/sdk";

// What Rovira sells now (automation, AI agents, custom systems) leads the
// rotation; real apps appear as proof of work ("project_showcase").
const CONTENT_ROTATION = ["problem_solution", "project_showcase", "ai_workforce"];

// Real projects only — drafts never invent work.
const PROJECTS = [
"دفتري (Daftari) — multi-tenant retail POS SaaS",
"Cafi — café management app",
"Humanitarian Aid Management System",
"MyNour — card distribution platform",
"Electricity Meters Management app",
"Senseivo — digital studio CMS",
"Madrasati / camp management apps"
];

const CONTENT_TYPE_BRIEF = {
problem_solution:
"Start from one specific, costly, repetitive task a company or agency deals with (manual follow-ups, copy-paste reports, answering the same questions, chasing approvals) and show how automation or an AI agent removes it. Concrete, no hype.",
project_showcase:
"Show one real Rovira project as proof of what we build for clients: the problem it solved and one concrete thing it does. If a matching real screenshot exists in the asset library, use it (mode = screenshot).",
ai_workforce:
"Rovira runs on its own AI employees (opportunity search, content drafting and publishing, Telegram approvals — nothing important happens without human approval). Use that as proof, then offer to build the same for the reader's company."
};

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export default class InstagramContentAgent extends Agent {
constructor() {
super({
id: "instagram-content",
name: "Instagram Content Agent",
cronSchedule: "0 11 * * 2,4,6" // Tue/Thu/Sat 11am — offset from LinkedIn's Mon/Wed/Fri
});
}

/**
 * Drafts a finished, on-brand post: Claude writes the caption + headline
 * and chooses either a REAL screenshot from the brand library or an AI
 * scene; PostComposer then draws the final 1080x1350 image (headline set
 * in code — image models never write the text). All of this is INTERNAL:
 * nothing is visible on Instagram until publishContainer() runs in
 * Executor.js after Reem approves.
 */
async run(manualIdea = null) {
const waitingId = await findWaitingDraft("instagramPosts", this.id);
if (waitingId) {
console.log(`📝 [${this.name}] A draft is already waiting for your approval — skipping this run.`);
return { skipped: `في مسودة إنستغرام لسا مستنية موافقتك (${waitingId}). وافقي عليها أو ارفضيها وبعدين بحضّر وحدة جديدة.` };
}

const contentType = await this.pickNextContentType(); // INTERNAL
const ideaText = manualIdea ? manualIdea.trim() : null;

const draft = await this.draftContent(contentType, ideaText); // INTERNAL — drafts only

// Resolve the visual: a real screenshot if the model picked a valid one,
// otherwise an AI scene. Never fails the whole run over a bad asset id.
let asset = null;
if (draft.mode === "screenshot" && draft.assetId) {
asset = await getBrandAsset(draft.assetId);
if (!asset || asset.active === false) asset = null;
}

let finalJpeg;
let imagePrompt = null;
if (asset) {
const screenshot = await downloadImage(asset.url); // INTERNAL — our own library
finalJpeg = await composeScreenshotCard(screenshot, {
headline: draft.headline,
subline: draft.subline,
label: [asset.app, asset.feature].filter(Boolean).join(" · ")
});
} else {
// Fallback if the model picked a screenshot id that doesn't exist.
imagePrompt =
draft.imagePrompt ||
`A calm, modern small-business office with a laptop and coffee on a wooden desk, soft morning light. ${IMAGE_PROMPT_FORMULA}`;
// Fixed set: Rovira's office always, the presenter only when the post
// calls for a person. Reference photos lock the look; SCENE_BIBLE text
// backs them up (and is all there is until Reem sends references).
const refs = await getSceneReferences({ withCharacter: Boolean(draft.withCharacter) });
const refBuffers = await Promise.all(refs.map(r => downloadImage(r.url)));
const refNote = refs.length
? `Reference images: ${refs.map((r, i) => `image ${i + 1} = ${r.kind === "character" ? "the presenter — keep the exact same face and outfit" : "the office — keep the same room, furniture, colors and light"}`).join("; ")}. `
: "";
imagePrompt = `${refNote}Setting: ${SCENE_BIBLE.place}${draft.withCharacter ? ` Person: ${SCENE_BIBLE.character}` : " No people."} Scene: ${imagePrompt}`;
const sceneBase64 = await generateImageWithReferences(imagePrompt, refBuffers, { size: "1024x1536" }); // INTERNAL — generates, doesn't publish
refs.forEach(r => markBrandAssetUsed(r.id));
finalJpeg = await composeSceneCard(sceneBase64, { headline: draft.headline, subline: draft.subline });
}

const imageUrl = await uploadImage(finalJpeg, `instagram-${Date.now()}`); // INTERNAL — hosting, not Instagram

// INTERNAL — an unpublished container is invisible to everyone.
const creationId = await createMediaContainer(imageUrl, draft.caption);

const postRef = await db.collection("instagramPosts").add({
contentType,
caption: draft.caption,
headline: draft.headline,
subline: draft.subline || null,
visualMode: asset ? "screenshot" : "scene",
assetId: asset?.id || null,
imagePrompt,
imageUrl,
creationId,
sourceIdea: ideaText || null,
approvalStatus: "WAITING_APPROVAL",
createdAt: new Date()
});

if (asset) await markBrandAssetUsed(asset.id); // INTERNAL — rotate screenshots

// GATED — publishContainer() (Executor.js) is the only thing that posts.
const approvalId = await requestApproval({
agentId: this.id,
actionType: "POST_INSTAGRAM_CONTENT",
summary: `مسودة بوست إنستغرام جاهزة (${contentType}${asset ? " · صورة حقيقية" : " · مشهد AI"}) — بانتظار موافقتك على النشر.`,
payload: {
postId: postRef.id,
contentType,
creationId,
caption: draft.caption
}
});

await sendTelegramPhoto(
imageUrl,
`${draft.caption}\n\n—\nموافقة: ${approvalId}\nوافقي بالرد (مثلاً "انشري") أو: /approve ${approvalId}`
);

await postRef.update({ approvalId });
console.log(` 📋 Draft queued for approval: ${contentType} — postId: ${postRef.id}, approvalId: ${approvalId}`);
return approvalId;
}

async pickNextContentType() {
const countSnap = await db.collection("instagramPosts").count().get();
const count = countSnap.data().count;
return CONTENT_ROTATION[count % CONTENT_ROTATION.length];
}

/**
 * One Claude call returns strict JSON: caption, the on-image headline and
 * subline, and the visual choice (a real screenshot by asset id, or an AI
 * scene prompt that follows the brand image formula).
 */
async draftContent(contentType, ideaText) {
const [instructions, companyContext, brandContext] = await Promise.all([
getAgentInstructions("instagram-content"),
getCompanyContext(),
getBrandContext()
]);
// Prefer the app sheets Reem saved (brandProducts); fall back to the
// built-in list until she has added any.
const savedProducts = await listProducts();
const catalog = savedProducts.length > 0 ? savedProducts.map(p => p.app) : PROJECTS;
const project = catalog[Math.floor(Math.random() * catalog.length)];
const brief = CONTENT_TYPE_BRIEF[contentType];

const systemPrompt = `انتي مديرة محتوى إنستغرام لشركة روفيرا (Rovira).

${brandContext}

نوع البوست المطلوب اليوم: ${contentType}.
${brief}
مشروع مرجعي (استخدميه بس إذا مناسب): ${project}
${ideaText ? `\nفكرة ريم المحددة لهاد البوست — اتبعيها، ولها الأولوية على كل شي فوق:\n${ideaText}\n` : ""}
${instructions ? `\nقواعد وخطة المحتوى الثابتة يلي ريم حددتها لإنستغرام — اتبعيها دايمًا:\n${instructions}\n` : ""}
${companyContext ? `\n${companyContext}\n` : ""}

رجعي JSON فقط، بدون أي نص قبله أو بعده، بالشكل:
{"caption": "...", "headline": "...", "subline": "...", "mode": "screenshot" | "scene", "assetId": "..." | null, "imagePrompt": "..." | null, "withCharacter": true | false}

caption: الكابشن بالعربي حسب صوت العلامة — هوك بأول سطر، فقرات قصيرة، دعوة وحدة للتواصل على واتساب بالآخر، و3-5 هاشتاقات عن الأتمتة/الذكاء الاصطناعي/الأعمال. إيموجي قليل.
headline: العنوان اللي رح ينكتب على الصورة — عربي، 2-6 كلمات، قوي ومباشر، بدون علامات تنصيص.
subline: سطر واحد قصير تحت العنوان (أو "" إذا مش لازم).
mode: "screenshot" إذا في صورة حقيقية بالمكتبة بتناسب البوست فعلًا (حطي الـ id بالضبط من القائمة بـ assetId)، وإلا "scene".
imagePrompt: بس إذا mode = "scene" — ${IMAGE_PROMPT_FORMULA}
withCharacter: true بس إذا المشهد محتاج إنسان (المقدّمة تبع روفيرا بتشرح، بتشتغل، بترحب). المكان دايمًا مكتب روفيرا الثابت، فاكتبي imagePrompt عن الفعل/اللقطة بس، مش عن المكان.
ممنوع تخترعي assetId مش موجود بالقائمة.`;

const message = await anthropic.messages.create({
model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
max_tokens: 1200,
system: systemPrompt,
messages: [{ role: "user", content: "اكتبي البوست." }]
});

const raw = message.content[0]?.text?.trim() || "{}";
const jsonMatch = raw.match(/\{[\s\S]*\}/);
const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

if (!parsed.caption || !parsed.headline) {
throw new Error(`Instagram draft response missing caption/headline: ${raw}`);
}
parsed.subline = parsed.subline || "";
return parsed;
}
}
