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
  $("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) { msg("Configuration error — please tell the office.", true); return; }
    const name = $("rName").value.trim();
    const title = $("rTitle").value.trim();
    if (!name || !title) return;

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
      </div>`).join("");

    // Look up live status for each token via the security-definer RPC.
    for (const r of list) {
      try {
        const { data } = await sb.rpc("public_request_status", { token: r.token });
        const rec = Array.isArray(data) ? data[0] : data;
        const row = box.querySelector(`[data-token="${cssEsc(r.token)}"] [data-status]`);
        if (!row) continue;
        if (rec) {
          row.textContent = STATUS_LABEL[rec.status] || rec.status;
          row.className = "status-badge s-" + rec.status;
        } else {
          row.textContent = "Not found";
        }
      } catch (e) { /* leave as checking */ }
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  let toastTimer;
  function toast(t) { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 2400); }

  renderTracked();
})();
