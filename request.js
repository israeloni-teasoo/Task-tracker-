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

  // Load the staff directory so the requester can choose who to send to.
  (async () => {
    const box = $("rRecipients");
    if (!box || !sb) return;
    try {
      const { data } = await sb.rpc("public_staff");
      const staff = data || [];
      if (!staff.length) { box.innerHTML = `<span class="check-empty">No staff listed yet — your request goes to the whole office.</span>`; return; }
      box.innerHTML = staff.map((s) => {
        const tag = s.role === "owner" ? " (Boss)" : "";
        return `<label class="check-item"><input type="checkbox" value="${esc(s.id)}" /> <span>${esc(s.name)}${tag}</span></label>`;
      }).join("");
    } catch (e) { box.innerHTML = `<span class="check-empty">Couldn't load staff — your request goes to the whole office.</span>`; }
  })();

  $("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) { msg("Configuration error — please tell the office.", true); return; }
    const name = $("rName").value.trim();
    const title = $("rTitle").value.trim();
    if (!name || !title) return;
    if (tooSoon("tasktrack.lastsubmit", 8000)) { msg("Please wait a few seconds before submitting again.", true); return; }

    const dueVal = $("rDue").value;
    const token = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
    const row = {
      title,
      notes: $("rNotes").value.trim(),
      requester_name: name,
      requester_department: $("rDept").value.trim() || null,
      due: dueVal ? new Date(dueVal).toISOString() : null,
      priority: $("rPriority").value,
      status: "pending",
      source: "request",
      track_token: token,
    };

    const btn = $("rSubmit");
    btn.disabled = true; btn.textContent = "Submitting…";
    const { error } = await sb.from("tasks").insert(row);

    if (error) { btn.disabled = false; btn.textContent = "Submit request"; msg(error.message || "Could not submit — please try again.", true); return; }

    // Optional attachment (uploads to the private bucket; linked by token).
    const file = $("rFile") && $("rFile").files && $("rFile").files[0];
    let fileNote = "";
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        fileNote = " (the file was too large to attach — 10 MB max)";
      } else {
        btn.textContent = "Uploading file…";
        try {
          const safe = file.name.replace(/[^\w.\-]+/g, "_");
          const path = `${token}/${Date.now()}-${safe}`;
          const up = await sb.storage.from("attachments").upload(path, file, { contentType: file.type || "application/octet-stream" });
          if (up.error) fileNote = " (couldn't attach the file)";
          else await sb.rpc("public_add_attachment", { token, p: path, fname: file.name, ctype: file.type, fsize: file.size });
        } catch (e) { fileNote = " (couldn't attach the file)"; }
      }
    }
    // Recipients ("who is this for?").
    const recipientIds = Array.from(document.querySelectorAll('#rRecipients input:checked')).map((c) => c.value);
    if (recipientIds.length) { try { await sb.rpc("public_set_recipients", { token, ids: recipientIds }); } catch (e) { /* non-fatal */ } }

    btn.disabled = false; btn.textContent = "Submit request";

    remember(token, title);
    e.target.reset();
    // Re-check nothing after reset (form.reset clears checkboxes already).
    msg("✓ Sent! It's now on their list. You can track it below." + fileNote, !!fileNote);
    showTrackLink(token);
    renderTracked();
  });

  // A shareable, secret link that lets the submitter track this request (and
  // send reminders) from any device — no account needed. The token is a random
  // UUID, so links can't be guessed.
  function trackUrlFor(token) {
    return location.origin + location.pathname + "#track=" + token;
  }
  function showTrackLink(token) {
    const box = $("trackLinkBox"), input = $("trackLinkInput");
    if (!box || !input) return;
    input.value = trackUrlFor(token);
    box.hidden = false;
  }
  const copyBtn = $("trackLinkCopy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const input = $("trackLinkInput");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch (e) {
        input.focus(); input.select();
        try { document.execCommand("copy"); } catch (_) {}
      }
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
  }

  // If arriving via a shared tracking link (#track=<token>), adopt it onto this
  // device so the request shows up under "My requests".
  async function importTrackTokenFromUrl() {
    const m = (location.hash || "").match(/track=([0-9a-f-]{10,})/i);
    if (!m) return;
    const token = m[1];
    // Clean the token out of the address bar.
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    if (myList().some((r) => r.token === token)) return;   // already tracked
    let title = "Your request";
    try {
      if (sb) {
        const { data } = await sb.rpc("public_request_status", { token });
        const rec = Array.isArray(data) ? data[0] : data;
        if (rec && rec.title) title = rec.title;
        else if (!rec) { toast("That tracking link wasn't found."); return; }
      }
    } catch (e) { /* still add it; status lookup will retry on render */ }
    remember(token, title);
  }

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
      <div class="request-row col" data-token="${esc(r.token)}">
        <div class="request-toprow">
          <div class="request-main">
            <div class="request-title">${esc(r.title)}</div>
            <div class="request-meta"><span class="status-badge s-pending" data-status>Checking…</span></div>
          </div>
          <button class="ghost-btn nudge-btn" data-nudge="${esc(r.token)}" disabled>Send Reminder</button>
        </div>
        <button class="linklike thread-toggle" data-thread="${esc(r.token)}">💬 Comments</button>
        <div class="mini-thread" data-box="${esc(r.token)}" hidden></div>
      </div>`).join("");

    box.querySelectorAll("[data-nudge]").forEach((b) => b.addEventListener("click", () => nudge(b.dataset.nudge, b)));
    box.querySelectorAll("[data-thread]").forEach((b) => b.addEventListener("click", () => toggleThread(b.dataset.thread)));

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
          if (nudgeBtn) {
            if (rec.status === "completed") {
              nudgeBtn.remove();                       // completed: no reminder button at all
            } else if (rec.needs_attention) {
              nudgeBtn.disabled = true; nudgeBtn.textContent = "Reminder sent";
            } else {
              nudgeBtn.disabled = false;
            }
          }
        } else {
          badge.textContent = "Not found";
        }
      } catch (e) { /* leave as checking */ }
    }
  }

  // ---- Per-request comment thread (public, by token) ----
  async function toggleThread(token) {
    const el = document.querySelector(`[data-box="${cssEsc(token)}"]`);
    if (!el) return;
    if (!el.hidden) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="mini-empty">Loading…</div>`;
    await loadMiniThread(token, el);
  }

  async function loadMiniThread(token, el) {
    let items = [];
    try {
      const { data } = await sb.rpc("public_request_events", { token });
      items = data || [];
    } catch (e) { /* show empty */ }
    const rows = items.length ? items.map((ev) => {
      const when = new Date(ev.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      if (ev.type === "nudge") return `<div class="mini-item sys">🔔 Reminder sent · ${esc(when)}</div>`;
      if (ev.type === "status_change") return `<div class="mini-item sys">${esc(ev.message || "Updated")} · ${esc(when)}</div>`;
      return `<div class="mini-item"><b>${esc(ev.author || "")}</b> <span class="mini-when">${esc(when)}</span><div>${esc(ev.message || "")}</div></div>`;
    }).join("") : `<div class="mini-empty">No comments yet.</div>`;
    el.innerHTML = `<div class="mini-list">${rows}</div>
      <div class="mini-compose">
        <input type="text" placeholder="Add a comment…" data-cinput maxlength="2000" />
        <button type="button" class="ghost-btn" data-csend>Send</button>
      </div>`;
    el.querySelector("[data-csend]").addEventListener("click", () => postMiniComment(token, el));
    el.querySelector("[data-cinput]").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); postMiniComment(token, el); } });
  }

  async function postMiniComment(token, el) {
    const input = el.querySelector("[data-cinput]");
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    try {
      const { data, error } = await sb.rpc("public_add_comment", { token, body });
      if (error || data === false) { toast("Couldn't post the comment."); input.value = body; return; }
    } catch (e) { toast("Couldn't post the comment."); input.value = body; return; }
    await loadMiniThread(token, el);
  }

  // One reminder per request every 30 minutes (matches the server-side limit).
  const REMINDER_COOLDOWN_MS = 30 * 60 * 1000;
  async function nudge(token, btn) {
    if (tooSoon("tasktrack.lastnudge." + token, REMINDER_COOLDOWN_MS)) {
      msg("You've already sent a reminder for this request. You can send another after about 30 minutes.", true);
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    const { data, error } = await sb.rpc("public_nudge", { token });
    // Success = boolean true (legacy fn) or the string 'ok' (rate-limited fn).
    const ok = data === true || data === "ok";
    if (error || !ok) {
      if (btn) { btn.disabled = false; btn.textContent = "Send Reminder"; }
      let m;
      if (error && /public_nudge|function|schema cache/i.test(error.message || "")) {
        m = "Reminders aren't switched on yet — the office admin needs to run the reminder migration.";
      } else if (error) {
        m = error.message || "Couldn't send the reminder.";
      } else if (data === "cooldown") {
        m = "A reminder was sent for this request recently — please try again in about 30 minutes.";
      } else if (data === "completed" || data === false) {
        m = "That request is already completed — no reminder needed.";
        if (btn) btn.remove();
      } else if (data === "notfound") {
        m = "We couldn't find that request.";
      } else {
        m = "Couldn't send the reminder.";
      }
      msg(m, true);
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Reminder sent"; }
    msg("👍 Reminder sent — they'll see it flagged.", false);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  let toastTimer;
  function toast(t) { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 2400); }

  (async () => { await importTrackTokenFromUrl(); renderTracked(); })();
})();
