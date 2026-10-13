import { listPendingApprovals, decideApproval } from "../core/ApprovalGate.js";
import { executeApproval } from "../core/Executor.js";
import { getTelegramUpdates, sendTelegramMessage, getTelegramFile } from "../integrations/TelegramClient.js";
import { uploadImage } from "../integrations/ImageHostClient.js";
import {
getBrandIdentity,
setBrandIdentity,
listBrandAssets,
addBrandAsset,
parseAssetCaption,
setProductInfo,
listProducts,
deactivateBrandAsset
} from "../core/BrandKit.js";
import { chatTurn } from "../integrations/ClaudeClient.js";
import { getTodaysActivity } from "../database/operations.js";
import { setAgentInstructions } from "../core/AgentInstructions.js";
import { replyAsTeam, handBackToSaad, listRecentConversations } from "../agents/SaadAgent.js";
import { phoneForTelegramMessage, linkTelegramMessage } from "../whatsapp/TelegramInbox.js";
import { getSaadRules, setSaadRules, addSaadAnswer, listSaadAnswers, removeSaadAnswer } from "../core/SaadTraining.js";
import { setProductSales, addTrialCodes, trialCodeStats } from "../core/ProductSales.js";
import { serviceAccountEmail } from "../integrations/SheetsClient.js";
import { setCompanyProfile, logCompanyUpdate } from "../core/CompanyKnowledge.js";

/**
* Reem's main interface. Long-polls Telegram for messages.
*
* Slash commands (handleCommand) are parsed directly and call the exact same
* functions approve.js / reject.js / list-approvals.js already call — a
* deterministic fallback that always works the same way.
*
* Free-text messages (handleNaturalLanguage / runConversationTurn) go
* through a real multi-turn conversation with Claude, using tool use: Claude
* can read approvals, read today's activity, run an agent, and
* approve/reject a specific request — by calling tools, the same way this
* file always did it. Nothing here can execute a GATED action except by
* going through decideApproval() + executeApproval(), exactly like the CLI.
* The model has no more power than the old command parser did — it just
* decides when to use that power based on a real conversation instead of a
* single classified intent, and the hard rule that it must never call
* approve/reject without Reem's clear, explicit, in-context "yes" on that
* specific item is written directly into SYSTEM_PROMPT below.
*
* Hard auth rule: only TELEGRAM_CHAT_ID (from .env) is ever listened to.
* Every other chat is silently ignored — no reply, no error, nothing that
* would tell a stranger this bot does anything at all. See docs/TELEGRAM_SETUP.md
* for first-time setup (creating the bot, finding your chat id).
*/

let offset = 0;

export function startTelegramBot(masterAgent) {
if (!process.env.TELEGRAM_BOT_TOKEN) {
console.log("ℹ️ Telegram bot not configured yet (TELEGRAM_BOT_TOKEN missing in .env) — skipping. See docs/TELEGRAM_SETUP.md.");
return;
}

if (!process.env.TELEGRAM_CHAT_ID) {
console.log("⚠️ TELEGRAM_CHAT_ID not set yet. Send any message to your bot on Telegram now —");
console.log(" the chat id will be printed right here so you can add it to .env, then restart.");
} else {
console.log("🤖 Telegram bot listening — talk to it any time.");
}

poll(masterAgent);
}

async function poll(masterAgent) {
// Long-polling loop — getTelegramUpdates() blocks up to 25s per call when
// idle, so this is not a busy loop. Runs for the life of the process.
while (true) {
try {
const updates = await getTelegramUpdates(offset);
for (const update of updates) {
offset = update.update_id + 1;
await handleUpdate(update, masterAgent);
}
} catch (error) {
// error.cause carries the real underlying reason (DNS/TLS/timeout/etc)
// for a generic "fetch failed" — surface it so a network-level block
// is distinguishable from a code bug.
const cause = error.cause ? ` — cause: ${error.cause.code || error.cause.message || error.cause}` : "";
console.error(`⚠️ Telegram polling error (will retry in 5s): ${error.message}${cause}`);
await sleep(5000);
}
}
}

async function handleUpdate(update, masterAgent) {
const message = update.message;
if (!message) return;
const isImage = Boolean(message.photo?.length) || Boolean(message.document?.mime_type?.startsWith("image/"));
if (!message.text && !isImage) return;

const chatId = String(message.chat.id);
const authorizedChatId = process.env.TELEGRAM_CHAT_ID;

if (!authorizedChatId) {
// Setup mode — print the id, reply to no one, execute nothing.
console.log(`\n📌 Message received from chat id: ${chatId}`);
console.log(` Add this to .env as TELEGRAM_CHAT_ID=${chatId}, then restart (npm start / npm run dev).\n`);
return;
}

if (chatId !== authorizedChatId) {
console.log(`⛔ Ignored a message from an unauthorized chat id (${chatId}).`);
return; // silent on purpose — never confirm to a stranger that this bot does anything
}

// Swipe-reply to a mirrored WhatsApp message = answer that customer.
const repliedTo = message.reply_to_message?.message_id;
if (repliedTo && !(message.text || "").startsWith("/")) {
const target = await phoneForTelegramMessage(repliedTo);
if (target) {
if (!message.text) return reply("حاليًا بقدر أبعت للزبون نص بس — اكتبي الرد كتابة.");
// "علّم: ..." on a mirrored message teaches Saad instead of messaging the customer.
const teach = message.text.trim().match(/^عل+ّ?م[:：]\s*([\s\S]+)/);
if (teach) {
const id = await addSaadAnswer(target.question || "", teach[1].trim(), "telegram-swipe");
return sendTelegramMessage(`🎓 سعد تعلّم (id: ${id}).${target.question ? `\nلما حدا يسأل: «${target.question.slice(0, 120)}»` : ""}\nرح يجاوب بهالمعنى من هلق. (ما انبعت إشي للزبون)`, undefined, { replyTo: message.message_id });
}
return handleInboxReply(target.phone, message.text.trim(), message.message_id);
}
}

if (isImage) {
return handleBrandAssetUpload(message);
}

const text = message.text.trim();
if (text.startsWith("/")) {
return handleCommand(text, masterAgent);
}
return handleNaturalLanguage(text, masterAgent);
}

// ---------------------------------------------------------------------------
// Conversational agent (free-text path)
// ---------------------------------------------------------------------------

/**
* Tool schema exposed to Claude for the conversation. Every one of these
* maps 1:1 onto a function this codebase already had before the chat
* rewrite (listPendingApprovals, getTodaysActivity, masterAgent.runNow,
* decideApproval+executeApproval) — this doesn't add new power, it lets the
* model reach the same power the slash commands always had, through a real
* conversation instead of one classified intent.
*/
const TOOLS = [
{
name: "get_saad_rules",
description: "يرجع قواعد سعد (موظف الواتساب) الحالية اللي ريم حاطتها: النبرة، الترحيب، شو يسأل، شو يحوّل دايمًا. استخدميها قبل set_saad_rules عشان تدمجي التعديل مع الموجود بدل ما تمسحيه.",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "set_saad_rules",
description: "يحفظ قواعد سعد كاملة (بتستبدل القديمة). اقرأي الموجود أول بـ get_saad_rules وادمجي. القواعد الصارمة بالكود (لا أسعار، لا مواعيد، لا وعود، لا ذكر اسم ريم) ما بتتغير مهما انكتب هون — إذا ريم طلبت سعد يعطي أسعار، وضّحيلها إنه هاد ممنوع بالكود وإنها هي اللي بترد على الأسعار.",
input_schema: { type: "object", properties: { rules: { type: "string" } }, required: ["rules"] }
},
{
name: "add_saad_answer",
description: "يعلّم سعد جواب معتمد لسؤال معين (لما حدا يسأل X جاوب Y). استخدميها لما ريم تقول «علّمي سعد…» أو تعطي سؤال وجواب.",
input_schema: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] }
},
{
name: "list_saad_answers",
description: "لائحة الأجوبة المعتمدة اللي سعد تعلّمها (id, question, answer).",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "remove_saad_answer",
description: "يلغي جواب معتمد من سعد بالـ id (من list_saad_answers).",
input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
},
{
name: "list_approvals",
description:
"يرجع لائحة كل طلبات الموافقة المنتظرة هلق (WAITING_APPROVAL) — كل عنصر فيه id, agentId, actionType, summary, contentText (نص المحتوى الكامل إذا وجد، متل بوست لينكدإن — لازم تعرضيه كامل لريم قبل ما تسأليها توافق ولا لأ، مش بس الملخص), requestedAt. استخدميها لما تحتاجي تعرفي شو منتظر، أو قبل أي approve/reject للتأكد من الـ id الصحيح — لا تخمّني id أبداً.",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "get_today_activity",
description:
"يرجع كل شي صار اليوم عبر كل الموظفين (tasks, opportunities, linkedinPosts) بتفاصيله الخام، بالإضافة لعدد طلبات الموافقة المنتظرة هلق. استخدميها لما ريم تسأل شو صار اليوم، وين الموظفين، أو شو الوضع العام.",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "run_agent",
description:
'يشغّل موظف (agent) معين هلق، فوراً. الموظفين المعروفين: "freelance-search" (يدوّر على فرص شغل جديدة على المنصات)، "linkedin-content" (يحضّر مسودة بوست لينكدإن)، و"instagram-content" (يحضّر مسودة بوست إنستغرام مع صورة حقيقية مولّدة). فيكي كمان تجربي أي agentId تاني إذا ريم ذكرته بالاسم صراحة.',
input_schema: {
type: "object",
properties: { agentId: { type: "string", description: "معرّف الموظف، متل freelance-search أو linkedin-content أو instagram-content" } },
required: ["agentId"]
}
},
{
name: "approve",
description:
"توافق نهائياً على طلب موافقة معين وتنفذه فوراً — إجراء لا رجعة فيه. استخدميها فقط لما ريم توافق بشكل واضح وصريح، بنفس هاي المحادثة، على عنصر محدد بعينه. لازم approvalId دقيق (من list_approvals) — إذا مش متأكدة أنهي طلب تقصد، لا تخمني، اسأليها أو استخدمي list_approvals وورّيها الخيارات قبل.",
input_schema: {
type: "object",
properties: { approvalId: { type: "string", description: "الـ id الدقيق متل ما طلع من list_approvals" } },
required: ["approvalId"]
}
},
{
name: "reject",
description:
"ترفض طلب موافقة معين. نفس شرط approve بالضبط: لازم approvalId دقيق وموافقة واضحة وصريحة من ريم إنها تقصد هاد الطلب بالذات.",
input_schema: {
type: "object",
properties: {
approvalId: { type: "string", description: "الـ id الدقيق متل ما طلع من list_approvals" },
reason: { type: "string", description: "سبب الرفض إذا ذكرته ريم (اختياري)" }
},
required: ["approvalId"]
}
},
{
name: "set_linkedin_instructions",
description:
"تحفظ أو تحدّث قواعد وخطة المحتوى الثابتة لموظف اللينكدإن — يستخدمها تلقائيًا مع كل مسودة جديدة من هلق وصاعدًا، لحد ما تتغيّر. استخدميها لما ريم تطلب تثبيت قواعد محتوى جديدة أو تعديل القواعد الموجودة.",
input_schema: {
type: "object",
properties: {
instructions: { type: "string", description: "النص الكامل للقواعد/الخطة يلي ريم حددتها — بيستبدل أي قواعد محفوظة سابقًا بالكامل." }
},
required: ["instructions"]
}
},
{
name: "set_instagram_instructions",
description:
"تحفظ أو تحدّث قواعد وخطة المحتوى الثابتة لموظف الإنستغرام (أنواع البوستات، المواضيع، الستايل) — يستخدمها مع كل مسودة جاية. بتستبدل القواعد السابقة بالكامل.",
input_schema: {
type: "object",
properties: {
instructions: { type: "string", description: "النص الكامل للقواعد/الخطة يلي ريم حددتها لإنستغرام." }
},
required: ["instructions"]
}
},
{
name: "get_brand_identity",
description: "ترجع ملف هوية العلامة الحالي (الجمهور، الخدمات، الصوت، قواعد الصور) يلي بيقرأه كل موظفين المحتوى. استخدميها قبل أي تعديل عليه.",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "set_brand_identity",
description:
"تستبدل ملف هوية العلامة المشترك بالكامل (بيقرأه موظف اللينكدإن والإنستغرام والريلز). استخدميها بس لما ريم تطلب صراحة تعديل الهوية — وجيبي النص الحالي أول بـ get_brand_identity وعدّلي عليه بدل ما تكتبيه من الصفر.",
input_schema: {
type: "object",
properties: {
identity: { type: "string", description: "النص الكامل الجديد لملف الهوية" }
},
required: ["identity"]
}
},
{
name: "list_brand_assets",
description: "ترجع لائحة الصور الحقيقية بمكتبة العلامة (screenshots التطبيقات وغيرها) مع الـ id، التطبيق، الميزة، وكم مرة انستخدمت.",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "set_product_info",
description:
"تحفظ ملف معلومات تطبيق واحد (لمين، المشكلة اللي بيحلها، الميزات، النتائج الحقيقية، المنصات، الحالة). بيقرأه كل موظفين المحتوى ووكيل الواتساب لاحقًا. بيستبدل ملف هاد التطبيق بالكامل — إذا ريم بدها تضيف على الموجود، جيبي النص الحالي بـ list_products وادمجي قبل الحفظ. احفظي بالضبط اللي ريم قالته، بدون ما تضيفي ميزات أو أرقام من عندك.",
input_schema: {
type: "object",
properties: {
app: { type: "string", description: "اسم التطبيق بالشكل المعتمد (نفس الاسم بمكتبة الصور): دفتري، Cafi، نظام المساعدات..." },
info: { type: "string", description: "نص ملف التطبيق كامل، مرتب بعناوين قصيرة" }
},
required: ["app", "info"]
}
},
{
name: "set_product_sales",
description: "تحفظ بطاقة البيع لتطبيق (اللي سعد بيبيع منها): الباقات والأسعار، روابط التنزيل، التجربة المجانية، أسماء تانية للتطبيق، وأرقام الإعلانات. بتدمج مع الموجود — ابعتي بس الحقول اللي ريم غيّرتها. الأسعار هي الوحيدة اللي سعد مسموح يحكيها، فاحفظيها حرفيًا متل ما ريم كتبتها وما تألفي أي رقم. إذا ريم ما حددت العملة أو المدة (شهري/سنوي)، اسأليها قبل الحفظ.",
input_schema: {
type: "object",
properties: {
app: { type: "string", description: "اسم التطبيق المعتمد (نفس اسم ملف التطبيق)" },
packages: {
type: "array",
description: "كل الباقات (بتستبدل لائحة الباقات القديمة كاملة)",
items: {
type: "object",
properties: {
name: { type: "string" },
price: { type: "string", description: "الرقم بس، متل 15" },
currency: { type: "string", description: "متل $ أو شيكل" },
period: { type: "string", description: "متل شهري، سنوي، مرة وحدة" },
includes: { type: "string", description: "شو بتشمل الباقة" }
},
required: ["name", "price"]
}
},
links: { type: "object", properties: { android: { type: "string" }, ios: { type: "string" }, web: { type: "string" }, windows: { type: "string" } } },
trialDays: { type: "number" },
trialNote: { type: "string", description: "كيف بتشتغل التجربة، متل: بتدخل الكود من شاشة التفعيل" },
keywords: { type: "array", items: { type: "string" }, description: "أسماء تانية للتطبيق بيستخدمها الزباين أو الإعلانات (Daftari، دفتر ديون، كاشير...)" },
adIds: { type: "array", items: { type: "string" }, description: "أرقام إعلانات Meta (Ad ID) اللي بتودّي لهاد التطبيق" }
},
required: ["app"]
}
},
{
name: "add_trial_codes",
description: "تضيف أكواد تجربة جاهزة لتطبيق — سعد بيعطي كل زبون كود واحد. الأكواد المكررة بتنتجاهل. ريم بتلصقها بأي شكل (سطر سطر أو بفواصل).",
input_schema: {
type: "object",
properties: { app: { type: "string" }, codes: { type: "array", items: { type: "string" } } },
required: ["app", "codes"]
}
},
{
name: "trial_codes_status",
description: "كم كود تجربة باقي وكم انعطى لكل تطبيق (أو لتطبيق واحد).",
input_schema: { type: "object", properties: { app: { type: "string" } }, required: [] }
},
{
name: "list_products",
description: "ترجع كل ملفات التطبيقات المحفوظة (الاسم والنص الكامل).",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "save_pending_image",
description:
"تحفظ آخر صورة بعتتها ريم بدون كابشن بمكتبة صور العلامة. استخدميها لما ريم توضّح شو هي الصورة (اسم التطبيق والشاشة/الميزة). البوت أصلًا بيستقبل الصور — لا تقولي إنك ما بتقدري.",
input_schema: {
type: "object",
properties: {
app: { type: "string", description: "اسم التطبيق بالشكل المعتمد: دفتري، Cafi، نظام المساعدات، MyNour، Senseivo، مدرستي..." },
feature: { type: "string", description: "الشاشة أو الميزة، متل: الرئيسية وصافي اليوم" }
},
required: ["app"]
}
},
{
name: "remove_brand_asset",
description: "تشيل صورة من مكتبة العلامة (بتوقف استخدامها، ما بتنمسح نهائيًا). بس لما ريم تطلب صراحة، وبالـ id الدقيق من list_brand_assets.",
input_schema: {
type: "object",
properties: { assetId: { type: "string" } },
required: ["assetId"]
}
},
{
name: "reply_to_customer",
description:
"تبعت رد من الفريق لزبون على واتساب سعد (+970)، باسم الفريق، وبتحوّل المحادثة لوضع 'مع الفريق' 12 ساعة (سعد بيسكت وبيحوّل الرسائل). استخدميها فقط لما ريم تملي عليكِ نص الرد بشكل صريح لزبون محدد — لا تألفي رد من عندك وتبعتيه، اعرضي المسودة عليها أول وخدي موافقتها الصريحة.",
input_schema: {
type: "object",
properties: {
phone: { type: "string", description: "رقم الزبون الدولي، أرقام بس، متل 9705xxxxxxx" },
text: { type: "string", description: "نص الرد الحرفي اللي ريم وافقت عليه" }
},
required: ["phone", "text"]
}
},
{
name: "list_whatsapp_conversations",
description: "ترجع آخر محادثات الزباين مع سعد (الرقم، الاسم، آخر رسالة، إذا كانت مع الفريق).",
input_schema: { type: "object", properties: {}, required: [] }
},
{
name: "hand_back_to_saad",
description: "ترجع محادثة زبون لسعد قبل ما يخلص وضع 'مع الفريق'. بس لما ريم تطلب.",
input_schema: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] }
},
{
name: "update_company_profile",
description:
"استخدمها لما ريم تطلب تحديث معلومات الشركة الثابتة (الخدمات، الأسعار، نبرة الصوت، معايير شغلها) — بيستبدل النص الحالي بالكامل.",
input_schema: {
type: "object",
properties: {
profile: { type: "string", description: "النص الكامل الجديد لملف الشركة" }
},
required: ["profile"]
}
},
{
name: "log_company_update",
description:
"استخدمها لما ريم تطلب تسجيل خبر أو تحديث عن الشركة ما كان أي ايجنت رح يعرفه تلقائيًا (مكالمة مع عميل، قرار، إلخ).",
input_schema: {
type: "object",
properties: {
text: { type: "string", description: "نص التحديث" }
},
required: ["text"]
}
}
];

const SYSTEM_PROMPT = `إنتي المساعد الشخصي لريم منصور جوا بوت تيليغرام — بتمثلي "AI Workforce" حق شركتها روفيرا (Rovira)، شركة برمجة فريلانس. احكي معها متل ما كلود يحكي مع حدا: بشكل طبيعي ومتجاوب، فيكي تناقشيها وتسأليها وتقترحي وتكملي فكرة عبر أكتر من رسالة — مش مجرد تصنيف أوامر ثابتة.

احكي عربي (عامية بسيطة قريبة من لهجة ريم) إلا إذا هي كتبت إنجليزي، وقتها جاوبي إنجليزي. خليكي مختصرة ومباشرة — هاد شات تيليغرام مش إيميل أو تقرير رسمي، فقرات قصيرة أحسن من نص طويل، وبدون رموز markdown زي ** أو #.

عندك أدوات (tools) توصلك على بيانات حقيقية من قاعدة البيانات وعلى تشغيل الموظفين والموافقة/الرفض على طلبات معينة. استخدمي الأدوات لما تحتاجي معلومة حقيقية أو تنفيذ إجراء — ما تخترعي أرقام أو حالة موظفين أو طلبات من عندك أبداً، وإذا في خطأ أو فشل بشي، قوليه بصراحة.

قواعد صارمة ما فيها نقاش أبداً، حتى لو ريم بدها تستعجل:
1. ما تستخدمي approve أو reject إلا لما ريم توافق أو ترفض بشكل واضح وصريح على طلب محدد، بنفس هاي المحادثة القريبة. كلام عام أو مبهم مش كافي.
2. إذا في أكتر من طلب منتظر وكلام ريم ممكن ينطبق على أكتر من واحد، لا تخمني إطلاقاً — استخدمي list_approvals ووريها الخيارات واسأليها أنهي واحد بالضبط تقصد قبل ما تنفذي أي شي.
3. ما تعيدي approve/reject على نفس الطلب مرتين، وما تنفذي أي إجراء ريم ما طلبته أو ما وافقت عليه صراحة — لا تبادري بالتنفيذ من نفسك.
4. list_approvals وget_today_activity وrun_agent إجراءات آمنة (قراءة أو تشغيل عمل عادي) فيكي تستخدميها براحتك لما تخدم الموضوع أو لما ريم تسأل — بس خبريها بجملة قصيرة شو عم تسوي.
5. ما في شي "سري" هون — جاوبيها بالحقيقة الكاملة من الأدوات دايماً، حتى لو في مشكلة أو خطأ صار.

مكتبة صور العلامة: ريم بتبعتلك screenshots حقيقية لتطبيقاتها هون بالشات، والبوت بيستقبلها ويحفظها (list_brand_assets بتوريكي شو موجود). إذا بعتت صورة بدون كابشن، ووضّحت برسالة بعدها شو هي، احفظيها بـ save_pending_image. ما تقولي أبدًا إنك ما بتقدري تستقبلي صور.

ملفات التطبيقات: لما ريم تبعت معلومات عن تطبيق (لمين، شو بيحل، الميزات، النتائج)، احفظيها بـ set_product_info تحت نفس اسم التطبيق اللي بمكتبة الصور. إذا ناقص شي مهم (لمين التطبيق، أو المشكلة اللي بيحلها)، اسأليها سؤال واحد قصير قبل الحفظ.

سعد (واتساب الزباين): لما يحوّل محادثة، بيوصل إشعار هون. إذا ريم بدها ترد على زبون، اعرضي عليها نص الرد بالضبط وخدي موافقتها الصريحة قبل ما تستخدمي reply_to_customer — هاد إرسال حقيقي لزبون.
بيع التطبيقات (سعد): بيانات البيع لكل تطبيق بتنحفظ بـ set_product_sales (الباقات والأسعار، الروابط، التجربة، أسماء تانية، أرقام الإعلانات) — وملف التطبيق الوصفي بـ set_product_info. أكواد التجربة بـ add_trial_codes، ولما ريم تسأل كم باقي: trial_codes_status. نبّهيها إذا تطبيق قرب تخلص أكواده.
تعليم سعد: «علّمي سعد إنه لما حدا يسأل… يجاوب…» = add_saad_answer. تغيير أسلوبه أو ترحيبه أو شو يسأل = get_saad_rules ثم set_saad_rules (دمج، مش مسح). سعد كمان بيتعلم لحاله من كل رد بتبعته ريم للزباين.

لو ريم بدها تحكي أو تسأل سؤال عام مش مرتبط بشغلة محددة، جاوبيها عادي بدون ما تستخدمي أي أداة.`;

// In-memory conversation history for the one authorized chat. Kept as raw
// Anthropic message objects so it can be sent back to the API as-is.
let conversationHistory = [];

// Indices into conversationHistory marking the end of each *complete*
// logical turn (one user message through Claude's final text reply, with
// every tool_use/tool_result pair inside it intact). Trimming only ever
// cuts at one of these — never mid-way through a tool_use/tool_result pair,
// which the API would reject.
let turnBoundaries = [];

const MAX_HISTORY_TURNS = 6;
const MAX_TOOL_ITERATIONS = 6;

function markTurnBoundary() {
turnBoundaries.push(conversationHistory.length);
if (turnBoundaries.length > MAX_HISTORY_TURNS) {
const dropCount = turnBoundaries.length - MAX_HISTORY_TURNS;
const cutIndex = turnBoundaries[dropCount - 1];
conversationHistory = conversationHistory.slice(cutIndex);
turnBoundaries = turnBoundaries.slice(dropCount).map(boundary => boundary - cutIndex);
}
}

/**
* Runs every tool Claude actually has access to. This is the only place any
* of these functions get called from the free-text path — approve/reject
* still go through decideApproval()/executeApproval() exactly like the
* slash commands and the CLI (approve.js/reject.js) do.
*/
async function executeTool(name, input, masterAgent) {
switch (name) {
case "list_approvals": {
const pending = await listPendingApprovals();
return pending.map((item, i) => ({
position: i + 1,
id: item.id,
agentId: item.agentId,
actionType: item.actionType,
summary: item.summary,
contentText: item.payload?.text ?? item.payload?.caption ?? null,
requestedAt: item.requestedAt?.toDate?.()?.toISOString?.() ?? null
}));
}

case "get_today_activity": {
const [activity, pending] = await Promise.all([getTodaysActivity(), listPendingApprovals()]);
return {
tasks: activity.tasks,
opportunities: activity.opportunities,
linkedinPosts: activity.linkedinPosts,
pendingApprovalsCount: pending.length,
pendingApprovals: pending.map(item => ({ id: item.id, agentId: item.agentId, summary: item.summary }))
};
}

case "run_agent": {
if (!input?.agentId) throw new Error("agentId is required");
const result = await masterAgent.runNow(input.agentId); // throws with the real error if the agent failed
if (result?.skipped) return { ok: false, skipped: result.skipped, agentId: input.agentId };
return { ok: true, agentId: input.agentId };
}

case "approve": {
if (!input?.approvalId) throw new Error("approvalId is required");
const result = await decideApproval(input.approvalId, "approve");
if (result.alreadyDecided) {
return { alreadyDecided: true, status: result.status, summary: result.summary };
}
try {
await executeApproval(input.approvalId);
return { ok: true, status: "APPROVED_AND_EXECUTED", summary: result.summary };
} catch (error) {
return { ok: false, status: "APPROVED_BUT_EXECUTION_FAILED", summary: result.summary, error: error.message };
}
}

case "reject": {
if (!input?.approvalId) throw new Error("approvalId is required");
const result = await decideApproval(input.approvalId, "reject", { reason: input.reason || null });
if (result.alreadyDecided) {
return { alreadyDecided: true, status: result.status, summary: result.summary };
}
return { ok: true, status: "REJECTED", summary: result.summary };
}

case "set_linkedin_instructions": {
if (!input?.instructions) throw new Error("instructions is required");
await setAgentInstructions("linkedin-content", input.instructions);
return { ok: true, agentId: "linkedin-content" };
}

case "get_saad_rules":
return { rules: (await getSaadRules()) || "(لسا ما في قواعد)" };
case "set_saad_rules":
if (!input?.rules) throw new Error("rules is required");
await setSaadRules(input.rules);
return { ok: true };
case "add_saad_answer":
if (!input?.answer) throw new Error("answer is required");
return { ok: true, id: await addSaadAnswer(input.question || "", input.answer) };
case "list_saad_answers":
return { answers: (await listSaadAnswers()).map(a => ({ id: a.id, question: a.question, answer: a.answer })) };
case "remove_saad_answer":
if (!input?.id) throw new Error("id is required");
await removeSaadAnswer(input.id);
return { ok: true };

case "set_instagram_instructions": {
if (!input?.instructions) throw new Error("instructions is required");
await setAgentInstructions("instagram-content", input.instructions);
return { ok: true, agentId: "instagram-content" };
}

case "get_brand_identity": {
return { identity: await getBrandIdentity() };
}

case "set_brand_identity": {
if (!input?.identity) throw new Error("identity is required");
await setBrandIdentity(input.identity);
return { ok: true };
}

case "list_brand_assets": {
const assets = await listBrandAssets();
return assets.map(a => ({ id: a.id, app: a.app, feature: a.feature, kind: a.kind, usedCount: a.usedCount || 0 }));
}

case "set_product_info": {
if (!input?.app || !input?.info) throw new Error("app and info are required");
await setProductInfo(input.app, input.info);
return { ok: true, app: input.app };
}

case "list_products": {
return (await listProducts()).map(p => ({ app: p.app, info: p.info, packages: p.packages || [], links: p.links || {}, trialDays: p.trialDays || null, trialNote: p.trialNote || null, keywords: p.keywords || [], adIds: p.adIds || [] }));
}

case "set_product_sales": {
if (!input?.app) throw new Error("app is required");
const { app, ...fields } = input;
await setProductSales(app, fields);
return { ok: true, app };
}

case "add_trial_codes": {
if (!input?.app || !input?.codes?.length) throw new Error("app and codes are required");
return await addTrialCodes(input.app, input.codes);
}

case "trial_codes_status":
return await trialCodeStats(input?.app || null);

case "save_pending_image": {
if (!input?.app) throw new Error("app is required");
return await savePendingImage(input.app, input.feature || null);
}

case "remove_brand_asset": {
if (!input?.assetId) throw new Error("assetId is required");
await deactivateBrandAsset(input.assetId);
return { ok: true, assetId: input.assetId };
}

case "reply_to_customer": {
if (!input?.phone || !input?.text) throw new Error("phone and text are required");
return await replyAsTeam(input.phone, input.text);
}

case "list_whatsapp_conversations": {
return await listRecentConversations(10);
}

case "hand_back_to_saad": {
if (!input?.phone) throw new Error("phone is required");
return await handBackToSaad(input.phone);
}

case "update_company_profile": {
if (!input?.profile) throw new Error("profile is required");
await setCompanyProfile(input.profile);
return { ok: true };
}

case "log_company_update": {
if (!input?.text) throw new Error("text is required");
await logCompanyUpdate(input.text, "manual");
return { ok: true };
}

default:
throw new Error(`Unknown tool: ${name}`);
}
}

/**
* The actual multi-turn tool-use loop: send the conversation to Claude,
* and if it asks to use a tool, run it and send the result back — repeat
* until Claude replies with plain text instead of a tool call. Mirrors the
* standard Anthropic tool-use pattern.
*/
// One conversation turn at a time. Without this, a message Reem sends while
// a slow tool is still running (e.g. run_agent → Instagram, ~1 min) lands
// between a tool_use and its tool_result, and the API rejects the whole
// history from then on ("tool_use ids were found without tool_result").
let turnQueue = Promise.resolve();

async function runConversationTurn(userText, masterAgent) {
const run = turnQueue.then(() => runConversationTurnNow(userText, masterAgent));
turnQueue = run.catch(() => {});
return run;
}

/** Drops everything after the last complete turn — used whenever a turn fails midway. */
function rollbackToLastBoundary() {
const keep = turnBoundaries.length ? turnBoundaries[turnBoundaries.length - 1] : 0;
conversationHistory = conversationHistory.slice(0, keep);
}

async function runConversationTurnNow(userText, masterAgent) {
rollbackToLastBoundary(); // self-heal if a previous turn was left half-done
conversationHistory.push({ role: "user", content: userText });

let iterations = 0;

while (true) {
iterations++;

let response;
try {
const pending = getPendingImage();
const system = pending
? `${SYSTEM_PROMPT}\n\nملاحظة الآن: في صورة وصلت من ريم بدون كابشن قبل ${Math.round((Date.now() - pending.at) / 60000)} دقيقة ومستنية تعرفي شو هي. إذا رسالتها بتوصف الصورة، احفظيها بـ save_pending_image فورًا.`
: SYSTEM_PROMPT;
response = await chatTurn({ system, tools: TOOLS, messages: conversationHistory });
} catch (error) {
// Roll back the WHOLE turn (not just the last message): if this failed
// after a tool call, popping one message would leave a tool_use with no
// tool_result and break every later message.
rollbackToLastBoundary();
return reply(`❌ ما قدرت اتواصل مع كلود (${error.message}). جربي كمان شوي أو استخدمي /help للأوامر الثابتة.`);
}

conversationHistory.push({ role: "assistant", content: response.content });

const toolUseBlocks = response.content.filter(block => block.type === "tool_use");

if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
const text = response.content
.filter(block => block.type === "text")
.map(block => block.text)
.join("\n")
.trim();
if (text) await reply(text);
markTurnBoundary();
return;
}

if (iterations > MAX_TOOL_ITERATIONS) {
conversationHistory.push({
role: "user",
content: toolUseBlocks.map(block => ({
type: "tool_result",
tool_use_id: block.id,
content: "تم إيقاف التنفيذ — وصلنا لأقصى عدد خطوات مسموح لهاي المحادثة.",
is_error: true
}))
});
await reply("⚠️ في شي طويل عم يصير عندي وقفته احتياطاً. جربي تسأليني بشكل أوضح أو أبسط.");
markTurnBoundary();
return;
}

const toolResults = [];
for (const block of toolUseBlocks) {
try {
const result = await executeTool(block.name, block.input, masterAgent);
toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
} catch (error) {
toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true });
}
}
conversationHistory.push({ role: "user", content: toolResults });
}
}

async function handleNaturalLanguage(text, masterAgent) {
try {
await runConversationTurn(text, masterAgent);
} catch (error) {
rollbackToLastBoundary();
await reply(`❌ صار خطأ غير متوقع: ${error.message}`);
}
}

// ---------------------------------------------------------------------------
// Slash commands (deterministic fallback path — unchanged behavior)
// ---------------------------------------------------------------------------

async function handleCommand(text, masterAgent) {
const [command, ...rest] = text.split(/\s+/);
const arg = rest.join(" ").trim();

switch (command) {
case "/start":
case "/help":
return reply(
"فيكي تحكيلي عادي بالعربي أو الإنجليزي، متل ما بتحكي مع حدا — اسألي، ناقشي، اطلبي شي، ووافقي أو ارفضي طلب وانا بفهم من سياق حديثنا.\n\n" +
"أو الأوامر الثابتة:\n\n" +
"/today — شو عملت الشركة اليوم + اقتراح\n" +
"/approvals — الطلبات المنتظرة موافقتك\n" +
"/approve <id> — وافقي على طلب\n" +
'/reject <id> سبب — ارفضي طلب\n' +
"/search — شغّلي البحث عن فرص جديدة الآن\n" +
"/post — شغّلي كتابة بوست لينكد إن الآن\n" +
"/instagram — شغّلي تحضير بوست إنستغرام (كابشن + صورة) الآن\n" +
"/run <agentId> — شغّلي أي موظف بالاسم\n" +
"💬 واتساب سعد: كل رسالة زبون بتوصلك هون — اسحبي رسالته لليمين واكتبي ردك وبيروح إله.\n🎓 تعليم سعد: اسحبي رد سعد واكتبي «علّم: الرد الأفضل»، أو احكيلي «علّمي سعد…».\n/reply <رقم> نص — نفس الشي بالرقم\n" +
"/saad <رقم> — رجّعي المحادثة لسعد\n" +
"/sheet — إيميل مشاركة شيت أسئلة الزباين\n\n" +
"📸 مكتبة الصور: ابعتيلي سكرينشوت حقيقي مع كابشن متل «دفتري - دفتر الديون» وبضيفه لمكتبة العلامة. الأفضل تبعتيه كملف (File) عشان يضل بجودته."
);

case "/approvals":
return handleApprovalsList();

case "/today":
return handleStatusReport(masterAgent);

case "/approve":
return handleApprove(arg);

case "/reject":
return handleReject(arg);

case "/search":
return handleRunAgent(masterAgent, "freelance-search", "🔍 عم أدوّر على فرص جديدة...");

case "/post":
return handleRunAgent(masterAgent, "linkedin-content", "✍️ عم أحضّر مسودة بوست...");

case "/instagram":
return handleRunAgent(masterAgent, "instagram-content", "🎨 عم أحضّر بوست إنستغرام (كابشن + صورة)...");

case "/reply": {
const [phone, ...words] = arg.split(/\s+/);
const text = words.join(" ").trim();
if (!phone || !text) return reply("استخدمي: /reply <رقم الزبون> نص الرد");
try {
const r = await replyAsTeam(phone, text);
return reply(`✅ انبعت الرد لـ +${r.to}. المحادثة صارت معك ${r.humanModeHours} ساعة (سعد ساكت). ترجعيها لسعد: /saad ${r.to}`);
} catch (error) {
return reply(`❌ ما انبعت: ${error.message}`);
}
}

case "/saad": {
if (!arg) return reply("استخدمي: /saad <رقم الزبون>");
const r = await handBackToSaad(arg);
return reply(`🤖 المحادثة مع +${r.to} رجعت لسعد.`);
}

case "/sheet": {
const email = serviceAccountEmail();
return reply(email ? `شاركي شيت أسئلة الزباين مع هاد الإيميل كـ «محرر»:\n${email}` : "ما لقيت إيميل حساب الخدمة (firebase-key.json).");
}

case "/run":
if (!arg) return reply("استخدمي: /run <agentId>");
return handleRunAgent(masterAgent, arg, `⚙️ تشغيل ${arg}...`);

default:
return reply(`ما فهمت الأمر "${command}". ارسلي /help لعرض الأوامر المتاحة.`);
}
}

async function handleApprovalsList() {
const pending = await listPendingApprovals();
if (pending.length === 0) return reply("✅ ما في طلبات موافقة منتظرة هلق.");

let msg = `🔒 ${pending.length} طلب/طلبات منتظرة:\n`;
pending.forEach((item, i) => {
msg += `\n${i + 1}. ${item.summary}${(item.payload?.text || item.payload?.caption) ? `\n\n«${item.payload.text || item.payload.caption}»` : ""}\n\n/approve ${item.id}\n/reject ${item.id} سبب\n`;
});
msg += '\nتقدري تحكيلي "وافقي على الأول" أو تناقشيني فيهم كمان، مش بس بالأوامر.';
return reply(msg);
}

async function handleApprove(approvalId) {
if (!approvalId) return reply("استخدمي: /approve <id>");

const result = await decideApproval(approvalId, "approve");
if (result.alreadyDecided) return reply(`⚠️ هاد الطلب أصلاً بحالة "${result.status}".`);

await reply(`✅ تمت الموافقة: ${result.summary}`);
try {
await executeApproval(approvalId);
await reply("📬 تم التنفيذ.");
} catch (error) {
await reply(`❌ اتوافق عليه، بس صار خطأ بالتنفيذ: ${error.message}`);
}
}

async function handleReject(text) {
const [approvalId, ...reasonParts] = text.split(/\s+/);
if (!approvalId) return reply('استخدمي: /reject <id> سبب');

const reason = reasonParts.join(" ");
const result = await decideApproval(approvalId, "reject", { reason });
if (result.alreadyDecided) return reply(`⚠️ هاد الطلب أصلاً بحالة "${result.status}".`);
return reply(`🚫 تم الرفض: ${result.summary}`);
}

/**
* "شو عملتو اليوم؟ وين الموظفين؟ شو بتقترحوا؟" — routes through the same
* conversational agent as free text, with a fixed prompt asking it to pull
* today's activity and pending approvals (via its own tools) and summarize
* them. This keeps /today and free-text status questions consistent, and
* means there's only one place ("get today's activity" + write-up) that can
* drift out of date instead of two.
*/
async function handleStatusReport(masterAgent) {
await reply("📊 عم لملم تقرير اليوم...");
try {
await runConversationTurn(
"أعطيني ملخص قصير لشو صار اليوم بالشركة (كل موظف شو عمل، بالأرقام الحقيقية)، وين كل الموظفين، كم طلب موافقة منتظر هلق، وخلصي باقتراح واحد محدد لأهم شي أعمله هلق.",
masterAgent
);
} catch (error) {
await reply(`❌ ما قدرت أحضّر تقرير اليوم: ${error.message}`);
}
}

/** Reem's swipe-reply to a customer's mirrored WhatsApp message. */
async function handleInboxReply(phone, text, ownMessageId) {
try {
const r = await replyAsTeam(phone, text);
await linkTelegramMessage(ownMessageId, r.to, null); // swiping her own reply works too
return sendTelegramMessage(`✅ انبعت لـ +${r.to}. سعد ساكت عن هالمحادثة ${r.humanModeHours} ساعة — ترجعيها إله: /saad ${r.to}`, undefined, { replyTo: ownMessageId });
} catch (error) {
const hint = /24|window|re-engage/i.test(error.message) ? "\n(واتساب بيسمح بالرد بس خلال 24 ساعة من آخر رسالة من الزبون.)" : "";
return sendTelegramMessage(`❌ ما انبعت: ${error.message}${hint}`, undefined, { replyTo: ownMessageId });
}
}

async function handleRunAgent(masterAgent, agentId, startMessage) {
await reply(startMessage);
try {
const result = await masterAgent.runNow(agentId);
if (result?.skipped) return reply(`⏸ ما حضّرت إشي جديد: ${result.skipped}`);
await reply("✅ خلص التشغيل — شيكي /approvals لأي شي جديد.");
} catch (error) {
await reply(`❌ صار خطأ: ${error.message}`);
}
}

/**
* Saves a real app screenshot Reem sends into the shared brand asset
* library. INTERNAL only: it hosts the image (no expiry) and records it —
* nothing is posted anywhere. Caption format: "التطبيق - الميزة #وسم".
*/
// The last image Reem sent WITHOUT a caption. Her next message usually
// says what it is ("هاي الرئيسية بتطبيق كافي"), so the conversation agent
// gets a save_pending_image tool for it. Expires after 30 minutes.
let pendingImage = null;
const PENDING_IMAGE_TTL_MS = 30 * 60 * 1000;

function imageInfo(message) {
if (message.document) return { fileId: message.document.file_id, width: null, height: null, isFile: true };
const biggest = message.photo[message.photo.length - 1];
return { fileId: biggest.file_id, width: biggest.width, height: biggest.height, isFile: false };
}

function getPendingImage() {
if (pendingImage && Date.now() - pendingImage.at > PENDING_IMAGE_TTL_MS) pendingImage = null;
return pendingImage;
}

async function handleBrandAssetUpload(message) {
const caption = (message.caption || "").trim();
const info = imageInfo(message);
if (!caption) {
pendingImage = { ...info, at: Date.now() };
return reply("📸 وصلت الصورة. شو هي؟ احكيلي اسم التطبيق والشاشة (متل «Cafi - الرئيسية») وبضيفها للمكتبة.");
}
return saveImageToLibrary(info, caption);
}

async function saveImageToLibrary(info, caption) {
try {
const { fileId, width, height } = info;
const buffer = await getTelegramFile(fileId);
const { app, feature, tags, kind } = parseAssetCaption(caption);
const url = await uploadImage(buffer, `asset-${Date.now()}`, { permanent: true });
const assetId = await addBrandAsset({ url, app, feature, tags, kind, width, height, telegramFileId: fileId });
if (kind !== "screenshot") {
const refs = await listBrandAssets({ kind });
return reply(`✅ انحفظت كمرجع ثابت ${kind === "place" ? "للمكان (مكتب روفيرا)" : "للشخصية (المقدّمة)"}\n(id: ${assetId}) — صار في ${refs.length}.\nكل مشهد AI جاي رح يتولّد عليها.`);
}
const assets = await listBrandAssets({ app });
return reply(
`✅ انضافت للمكتبة: ${app}${feature ? ` — ${feature}` : ""}\n(id: ${assetId})\nصار عند «${app}» ${assets.length} صورة.` +
(info.isFile ? "" : "\n\nملاحظة: تيليجرام بيضغط الصور العادية — إذا بدك جودة أعلى ابعتيها كملف (File).")
);
} catch (error) {
return reply(`❌ ما قدرت أحفظ الصورة: ${error.message}`);
}
}

/** Used by the save_pending_image tool. Returns a plain result for Claude. */
async function savePendingImage(app, feature) {
const pending = getPendingImage();
if (!pending) return { ok: false, error: "ما في صورة منتظرة (أو مر عليها أكتر من 30 دقيقة) — اطلبي من ريم تبعتها مرة تانية." };
pendingImage = null;
const caption = feature ? `${app} - ${feature}` : app;
await saveImageToLibrary(pending, caption);
return { ok: true, saved: caption };
}

function reply(text) {
return sendTelegramMessage(text);
}

function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}
