/**
 * Appends rows to Reem's Google Sheet ("Rovira — أسئلة الزباين"), so every
 * customer question Saad receives is visible in one place she can sort,
 * filter and share.
 *
 * Auth reuses the existing service account in firebase-key.json (the same
 * Google Cloud project as Firestore) with the Sheets scope. One-time setup:
 *   1. Enable "Google Sheets API" in that Google Cloud project (free, no
 *      billing account needed).
 *   2. Share the sheet with the service account's email as Editor — the
 *      bot prints that email for you (/sheet on Telegram).
 *   3. Put the sheet id in .env as SAAD_SHEET_ID.
 *
 * Never throws: a failed sheet write is logged and reported, but never
 * blocks Saad's reply or the Firestore log (which is the source of truth).
 */

import fs from "fs";
import path from "path";
import { JWT } from "google-auth-library";

const KEY_PATH = path.join(process.cwd(), "firebase-key.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let client = null;
function getClient() {
  if (!client) {
    const key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    client = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  }
  return client;
}

/** The email Reem shares the sheet with. Not a secret. */
export function serviceAccountEmail() {
  try {
    return JSON.parse(fs.readFileSync(KEY_PATH, "utf8")).client_email || null;
  } catch {
    return null;
  }
}

export async function appendSheetRow(values, { sheetId = process.env.SAAD_SHEET_ID, range = "A:H" } = {}) {
  if (!sheetId) {
    console.log("ℹ️  SAAD_SHEET_ID not set — skipping Google Sheet log (Firestore log still written).");
    return { ok: false, reason: "SAAD_SHEET_ID not set" };
  }
  try {
    const { token } = await getClient().getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values.map(v => (v == null ? "" : String(v)))] })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `Sheets API HTTP ${res.status}`);
    }
    return { ok: true };
  } catch (error) {
    console.error("⚠️  Couldn't append to Google Sheet:", error.message);
    return { ok: false, reason: error.message };
  }
}
