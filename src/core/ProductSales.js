import { db } from "../config/firebase.js";
import { productSlug, listProducts } from "./BrandKit.js";

/**
 * The sales side of each app, for "سعد" — everything Reem sets from
 * Telegram so Saad can sell an app on his own:
 *
 *   brandProducts/<slug>   (same doc as the product sheet `info`)
 *     packages   [{ name, price, currency, period, includes }]  — the ONLY
 *                prices Saad may ever say; the code guard checks every
 *                number in his reply against this list
 *     links      { android, ios, web, windows }
 *     trialDays  number, trialNote text
 *     keywords   extra names customers/ads use for the app
 *     adIds      Meta ad ids that point at this app (Click-to-WhatsApp)
 *
 *   trialCodes/<auto>      { app: slug, code, status: available|given,
 *                            givenTo, givenAt } — handed out one per
 *                            customer per app by giveTrialCode()
 */

export async function setProductSales(app, fields) {
  const clean = Object.fromEntries(Object.entries(fields || {}).filter(([, v]) => v !== undefined && v !== null));
  await db.collection("brandProducts").doc(productSlug(app)).set({ app: String(app).trim(), ...clean, updatedAt: new Date() }, { merge: true });
}

export async function getSalesCatalog() {
  return (await listProducts()).map(p => ({ slug: p.id, ...p }));
}

export async function addTrialCodes(app, codes) {
  const slug = productSlug(app);
  const list = [...new Set((Array.isArray(codes) ? codes : String(codes).split(/[\s,،]+/)).map(c => String(c).trim()).filter(Boolean))];
  const existing = new Set((await db.collection("trialCodes").where("app", "==", slug).get()).docs.map(d => d.data().code));
  let added = 0;
  for (const code of list) {
    if (existing.has(code)) continue;
    await db.collection("trialCodes").add({ app: slug, code, status: "available", givenTo: null, givenAt: null, createdAt: new Date() });
    added++;
  }
  return { app: slug, added, skippedDuplicates: list.length - added };
}

export async function trialCodeStats(app = null) {
  const snap = await db.collection("trialCodes").get();
  const stats = {};
  for (const d of snap.docs) {
    const c = d.data();
    if (app && c.app !== productSlug(app)) continue;
    stats[c.app] ||= { available: 0, given: 0 };
    stats[c.app][c.status === "given" ? "given" : "available"]++;
  }
  return stats;
}

/** One code per customer per app: returns their existing code, or the next free one, or null. */
export async function giveTrialCode(slug, phone) {
  const all = (await db.collection("trialCodes").where("app", "==", slug).get()).docs;
  const mine = all.find(d => d.data().givenTo === phone);
  if (mine) return { code: mine.data().code, reused: true };
  const free = all.find(d => d.data().status === "available");
  if (!free) return null;
  await free.ref.update({ status: "given", givenTo: phone, givenAt: new Date() });
  const remaining = all.filter(d => d.data().status === "available").length - 1;
  return { code: free.data().code, reused: false, remaining };
}

/**
 * Which app is this customer asking about? A Click-to-WhatsApp ad id wins;
 * then the ad's headline/body, then the message text, matched against the
 * app name and its keywords.
 */
export function detectProduct(catalog, { referral = null, text = "" } = {}) {
  if (referral?.source_id) {
    const byAd = catalog.find(p => (p.adIds || []).map(String).includes(String(referral.source_id)));
    if (byAd) return byAd.slug;
  }
  const hay = `${referral?.headline || ""} ${referral?.body || ""} ${text || ""}`.toLowerCase();
  for (const p of catalog) {
    const names = [p.app, ...(p.keywords || [])].filter(Boolean).map(n => String(n).toLowerCase());
    if (names.some(n => n.length > 1 && hay.includes(n))) return p.slug;
  }
  return null;
}

/** Every number Saad is allowed to say: package prices, trial days, numbers in package periods. */
export function allowedNumbers(catalog) {
  const nums = new Set();
  for (const p of catalog) {
    for (const pk of p.packages || []) {
      for (const n of String(pk.price ?? "").match(/\d+(?:\.\d+)?/g) || []) nums.add(Number(n));
      for (const n of String(pk.period ?? "").match(/\d+(?:\.\d+)?/g) || []) nums.add(Number(n));
    }
    if (p.trialDays) nums.add(Number(p.trialDays));
  }
  return nums;
}

/** The product block for Saad's prompt — the focused app first and in full. */
export function formatCatalog(catalog, focusSlug = null) {
  const ordered = [...catalog].sort((a, b) => (b.slug === focusSlug) - (a.slug === focusSlug));
  return ordered
    .map(p => {
      const lines = [`### ${p.app} (slug: ${p.slug})${p.slug === focusSlug ? " ← هاد اللي الزبون جاي عشانه" : ""}`];
      if (p.info) lines.push(p.info);
      if (p.packages?.length) {
        lines.push(
          "الباقات والأسعار (الأسعار الوحيدة المسموحة، حرفيًا):\n" +
            p.packages.map(pk => `- ${pk.name}: ${pk.price} ${pk.currency || ""}${pk.period ? ` / ${pk.period}` : ""}${pk.includes ? ` — ${pk.includes}` : ""}`).join("\n")
        );
      } else {
        lines.push("الباقات والأسعار: (مش محددة — أي سؤال عن السعر بيتحوّل للفريق)");
      }
      const links = Object.entries(p.links || {}).filter(([, v]) => v);
      if (links.length) lines.push(`روابط التنزيل: ${links.map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
      if (p.trialDays || p.trialNote) lines.push(`التجربة المجانية: ${p.trialDays ? `${p.trialDays} يوم` : ""} ${p.trialNote || ""}`.trim());
      return lines.join("\n");
    })
    .join("\n\n");
}
