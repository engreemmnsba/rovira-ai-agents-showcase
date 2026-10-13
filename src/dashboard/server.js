import "dotenv/config";
import express from "express";
import { listPendingApprovals, decideApproval } from "../core/ApprovalGate.js";
import { executeApproval } from "../core/Executor.js";

/**
 * A local, browser-based alternative to running approve.js/reject.js by
 * hand — same underlying functions, same rules (nothing here bypasses
 * ApprovalGate or Executor's own checks), just a page instead of typing
 * commands. Runs only on your own machine (localhost) — nothing here is
 * reachable from outside your PC. See docs/DASHBOARD.md.
 */
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(express.urlencoded({ extended: true }));

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage(pending, message = "") {
  const rows =
    pending.length === 0
      ? `<p class="empty">✅ ما في شي بانتظار موافقتك الآن.</p>`
      : pending
          .map(
            (item) => `
      <div class="card">
        <div class="meta">${escapeHtml(item.agentId)} → ${escapeHtml(item.actionType)}</div>
        <div class="summary">${escapeHtml(item.summary)}</div>
        ${item.payload?.text ? `<div class="text">${escapeHtml(item.payload.text)}</div>` : ""}
        <form method="POST" action="/approve/${item.id}" class="inline">
          <button class="approve" type="submit">✅ موافقة</button>
        </form>
        <form method="POST" action="/reject/${item.id}" class="inline">
          <input type="text" name="reason" placeholder="سبب الرفض (اختياري)">
          <button class="reject" type="submit">🚫 رفض</button>
        </form>
      </div>`
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>لوحة موافقات Rovira</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e8e8ec; max-width:720px; margin:40px auto; padding:0 16px; }
  h1 { font-size:1.4rem; }
  .card { background:#1a1d27; border:1px solid #2c2f3a; border-radius:12px; padding:16px; margin-bottom:14px; }
  .meta { color:#8b8fa3; font-size:0.85rem; margin-bottom:6px; }
  .summary { margin-bottom:10px; }
  .text { background:#0f1117; border-radius:8px; padding:10px; margin-bottom:12px; white-space:pre-wrap; font-size:0.9rem; color:#c9cbd6; }
  form.inline { display:inline-block; margin-inline-end:8px; }
  button { border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font-size:0.9rem; }
  .approve { background:#22c55e; color:#04170b; }
  .reject { background:#ef4444; color:#2a0505; }
  input[type=text] { background:#0f1117; border:1px solid #2c2f3a; color:#e8e8ec; border-radius:8px; padding:6px 10px; margin-inline-end:8px; }
  .empty { color:#8b8fa3; }
  .msg { background:#1a1d27; border:1px solid #3b82f6; border-radius:8px; padding:10px; margin-bottom:16px; }
</style>
</head>
<body>
<h1>🔒 لوحة موافقات Rovira</h1>
${message ? `<div class="msg">${message}</div>` : ""}
${rows}
</body>
</html>`;
}

app.get("/", async (req, res) => {
  const pending = await listPendingApprovals();
  res.send(renderPage(pending));
});

app.post("/approve/:id", async (req, res) => {
  const result = await decideApproval(req.params.id, "approve");
  let message;
  if (result.alreadyDecided) {
    message = `⚠️ هاد الطلب قرر فيه من قبل (${result.status}).`;
  } else {
    try {
      await executeApproval(req.params.id);
      message = `✅ تمت الموافقة والتنفيذ.`;
    } catch (error) {
      message = `⚠️ تمت الموافقة، بس فشل التنفيذ: ${escapeHtml(error.message)}`;
    }
  }
  const pending = await listPendingApprovals();
  res.send(renderPage(pending, message));
});

app.post("/reject/:id", async (req, res) => {
  const result = await decideApproval(req.params.id, "reject", { reason: req.body.reason || "" });
  const message = result.alreadyDecided ? `⚠️ هاد الطلب قرر فيه من قبل (${result.status}).` : `🚫 تم الرفض.`;
  const pending = await listPendingApprovals();
  res.send(renderPage(pending, message));
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🖥️  لوحة الموافقات شغالة: http://localhost:${PORT}`);
  console.log(`اتركي هاد الترمينال مفتوح، وافتحي الرابط بالمتصفح كل ما بدك تراجعي/توافقي.\n`);
});
