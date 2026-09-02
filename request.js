/* Public office request page — no account needed.
   Submits requests via the anon key (RLS allows insert-only) and lets the
   submitter's own device track status by token. */

(function () {
  "use strict";

  const CFG = window.TASKTRACK_SUPABASE || {};
  const sb = (window.supabase && CFG.url) ? window.supabase.createClient(CFG.url, CFG.anonKey) : null;
  const MY_KEY = "tasktrack.myrequests";   // [{ token, title }]

  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");

  // ---- Theme toggle ----
  $("themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme")
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("tasktrack.theme", next); } catch (e) {}
  });

  // ---- Submit ----
  // Light client-side cooldown to discourage rapid-fire spam (server also caps
  // field sizes; real rate-limiting is enforced by Supabase at the edge).
  function tooSoon(key, ms) {
    try {
      const last = Number(localStorage.getItem(key) || 0);
      if (Date.now() - last < ms) return true;
      localStorage.setItem(key, String(Date.now()));
    } catch (e) {}
    return false;
  }

  $("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) { msg("Configuration error — please tell the office.", true); return; }
    const name = $("rName").value.trim();
    const title = $("rTitle").value.trim();
    if (!name || !title) return;
    if (tooSoon("tasktrack.lastsubmit", 8000)) { msg("Please wait a few seconds before submitting again.", true); return; }

    const token = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
    const row = {
      title,
      notes: $("rNotes").value.trim(),
      requester_name: name,
      requester_department: $("rDept").value.trim() || null,
      due: $("rDue").value || null,
      priority: $("rPriority").value,
      status: "pending",
      source: "request",
      track_token: token,
    };

    const btn = $("rSubmit");
    btn.disabled = true; btn.textContent = "Submitting…";
    const { error } = await sb.from("tasks").insert(row);
    btn.disabled = false; btn.textContent = "Submit request";

    if (error) { msg(error.message || "Could not submit — please try again.", true); return; }

    remember(token, title);
    e.target.reset();
    msg("✓ Sent! It's now on their list. You can track it below.", false);
    renderTracked();
  });

  function msg(text, isErr) {
    const el = $("rMsg");
    el.hidden = false;
    el.className = "auth-msg " + (isErr ? "err" : "ok");
    el.textContent = text;
  }

  // ---- Local tracking ----
  function myList() {
    try { return JSON.parse(localStorage.getItem(MY_KEY) || "[]"); } catch (e) { return []; }
  }
  function remember(token, title) {
    const list = myList();
    list.unshift({ token, title });
    try { localStorage.setItem(MY_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {}
  }

  const STATUS_LABEL = { pending: "Pending", inprogress: "In Progress", blocked: "Blocked", onhold: "On Hold", completed: "Completed" };

  async function renderTracked() {
    const list = myList();
    const section = $("trackSection"), box = $("trackList");
    if (!list.length) { section.hidden = true; return; }
    section.hidden = false;
    box.innerHTML = list.map((r) => `
      <div class="request-row" data-token="${esc(r.token)}">
        <div class="request-main">
          <div class="request-title">${esc(r.title)}</div>
          <div class="request-meta"><span class="status-badge s-pending" data-status>Checking…</span></div>
        </div>
        <button class="ghost-btn nudge-btn" data-nudge="${esc(r.token)}" disabled>Send Reminder</button>
      </div>`).join("");

    box.querySelectorAll("[data-nudge]").forEach((b) => b.addEventListener("click", () => nudge(b.dataset.nudge, b)));

    // Look up live status for each token via the security-definer RPC.
    for (const r of list) {
      try {
        const { data } = await sb.rpc("public_request_status", { token: r.token });
        const rec = Array.isArray(data) ? data[0] : data;
        const rowEl = box.querySelector(`[data-token="${cssEsc(r.token)}"]`);
        if (!rowEl) continue;
        const badge = rowEl.querySelector("[data-status]");
        const nudgeBtn = rowEl.querySelector("[data-nudge]");
        if (rec) {
          badge.textContent = STATUS_LABEL[rec.status] || rec.status;
          badge.className = "status-badge s-" + rec.status;
          if (nudgeBtn) nudgeBtn.disabled = rec.status === "completed";   // can't remind on a done request
          if (rec.needs_attention && nudgeBtn) nudgeBtn.textContent = "Reminder sent";
        } else {
          badge.textContent = "Not found";
        }
      } catch (e) { /* leave as checking */ }
    }
  }

  async function nudge(token, btn) {
    if (tooSoon("tasktrack.lastnudge." + token, 60000)) { msg("You've already sent a reminder recently — give them a moment.", true); return; }
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    const { data, error } = await sb.rpc("public_nudge", { token });
    if (error || data === false) {
      if (btn) { btn.disabled = false; btn.textContent = "Send Reminder"; }
      let m = error ? (error.message || "Couldn't send the reminder.") : "That request can't be reminded (already completed).";
      // Friendlier hint for the common "function not installed yet" case.
      if (error && /public_nudge|function|schema cache/i.test(error.message || "")) {
        m = "Reminders aren't switched on yet — the office admin needs to run migration 007.";
      }
      msg(m, true);
      return;
    }
    if (btn) btn.textContent = "Reminder sent";
    msg("👍 Reminder sent — they'll see it flagged.", false);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  let toastTimer;
  function toast(t) { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 2400); }

  renderTracked();
})();
