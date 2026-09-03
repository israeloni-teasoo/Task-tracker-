/* ============================================================
   TaskTrack — application logic (cloud sync)
   Login (email magic-link) + Supabase-backed tasks & projects
   with realtime sync across devices. Falls back to a read-only
   local cache when offline.
   ============================================================ */

(function () {
  "use strict";

  // ---- Supabase client ----
  const CFG = window.TASKTRACK_SUPABASE || {};
  const sb = (window.supabase && CFG.url)
    ? window.supabase.createClient(CFG.url, CFG.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;
  const PROJECT_REF = (CFG.url || "").replace(/^https?:\/\//, "").split(".")[0];
  const CACHE_KEY = "tasktrack.cache";
  const LOCAL_KEY = "tasktrack.v2";   // legacy on-device tasks (for optional upload)

  // ---- Board columns ----
  const STATUSES = [
    { key: "pending",    label: "Pending",     color: "var(--s-pending)" },
    { key: "inprogress", label: "In Progress", color: "var(--s-inprogress)" },
    { key: "blocked",    label: "Blocked",     color: "var(--s-blocked)" },
    { key: "onhold",     label: "On Hold",     color: "var(--s-onhold)" },
    { key: "completed",  label: "Completed",   color: "var(--s-completed)" },
  ];
  const statusLabel = (k) => (STATUSES.find((s) => s.key === k) || {}).label || k;
  const PALETTE = ["#3b82f6", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899", "#6366f1"];
  const ROLE_LABEL = { owner: "Owner", delegate: "Delegate", editor: "Editor", viewer: "Viewer", requester: "Requester" };

  // ---- State ----
  let projects = [], tasks = [], people = [];
  let profilesById = {};
  let me = null, myRole = "requester";
  let scope = "all", view = "list", query = "";
  let appReady = false, realtimeChannel = null;
  const seenTaskIds = new Set();   // for "new request" toasts

  // ---- Elements ----
  const $ = (id) => document.getElementById(id);
  const bootEl = $("bootLoading"), authScreen = $("authScreen"), appEl = $("app");
  const boardView = $("boardView"), listView = $("listView"), viewTitle = $("viewTitle");
  const searchInput = $("search"), toastEl = $("toast"), projectListEl = $("projectList");

  const can = {
    edit: () => ["owner", "delegate", "editor"].includes(myRole),
    delete: () => ["owner", "delegate"].includes(myRole),
    staff: () => ["owner", "delegate", "editor", "viewer"].includes(myRole),
  };

  // ============================================================
  //  Mapping between DB rows (snake_case) and app objects
  // ============================================================
  const taskFromRow = (r) => ({
    id: r.id, title: r.title, notes: r.notes || "", projectId: r.project_id,
    priority: r.priority, status: r.status, due: r.due || "",
    source: r.source, requesterId: r.requester_id, needsAttention: !!r.needs_attention,
    requesterName: r.requester_name || "", requesterDept: r.requester_department || "",
    created: r.created_at,
  });
  const rowFromTask = (t) => ({
    title: t.title, notes: t.notes, project_id: t.projectId || null,
    priority: t.priority, status: t.status, due: t.due || null,
  });
  const projFromRow = (r) => ({ id: r.id, name: r.name, color: r.color, isDefault: r.is_default, position: r.position });

  // ============================================================
  //  Boot & auth
  // ============================================================
  async function boot() {
    if (!sb) { fatal("Cloud config missing. Check supabase-config.js and vendor/supabase.js."); return; }
    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch (e) { /* offline */ }
    if (session) await enterApp(session);
    else showAuth();

    sb.auth.onAuthStateChange((event, sess) => {
      if (event === "SIGNED_IN" && sess) enterApp(sess);
      else if (event === "SIGNED_OUT") location.reload();
    });
  }

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function showAuth() {
    hide(bootEl); hide(appEl); show(authScreen);
    $("authEmail").focus();
  }

  function fatal(msg) {
    hide(bootEl);
    document.body.insertAdjacentHTML("beforeend",
      `<div class="toast" style="background:#ef4444;color:#fff">${esc(msg)}</div>`);
  }

  async function enterApp(session) {
    if (appReady) return;         // guard against duplicate SIGNED_IN events
    appReady = true;
    me = session.user;
    hide(authScreen); hide(bootEl);
    await loadRole();

    if (myRole === "requester") {
      // Office staff: the simplified request portal.
      show($("portalScreen"));
      $("portalEmail").textContent = me.email || "";
      await loadTasks();          // returns only their own requests (RLS)
      subscribeRealtime();
      renderRequests();
      return;
    }

    // Boss / delegate / editor / viewer: the full app.
    show(appEl);
    renderAccount();
    await Promise.all([loadProjects(), loadTasks(), loadPeople()]);
    primeSeen();               // seed before realtime so existing requests don't toast
    saveCache();
    subscribeRealtime();
    render();
    setupNotifications();
    maybeOfferLocalUpload();
    maybePromptPassword();
  }

  // ---- Login form ----
  let authMode = "password";   // "password" | "link"

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      authMode = tab.dataset.mode;
      const pw = authMode === "password";
      $("passwordField").hidden = !pw;
      $("authSubmit").textContent = pw ? "Sign in" : "Send me a login link";
      $("authHint").textContent = pw
        ? "Access is by invitation. Sign in with the email you were invited on."
        : "We'll email a one-time link to your invited address. New here? Ask the Owner for an invite.";
      $("authMsg").hidden = true;
    });
  });

  function authMsg(text, ok) {
    const m = $("authMsg");
    m.hidden = false;
    m.className = "auth-msg " + (ok ? "ok" : "err");
    m.textContent = text;
  }

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim();
    if (!email) return;
    const btn = $("authSubmit");

    if (authMode === "password") {
      const password = $("authPassword").value;
      if (!password) { authMsg("Enter your password, or use the Email link tab.", false); return; }
      btn.disabled = true; btn.textContent = "Signing in…";
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false; btn.textContent = "Sign in";
      if (error) authMsg(error.message + " — no password yet? Use the Email link tab, then set one in the app.", false);
      // success -> onAuthStateChange handles entering the app
    } else {
      btn.disabled = true; btn.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0] } });
      btn.disabled = false; btn.textContent = "Send me a login link";
      if (error) authMsg(error.message, false);
      else authMsg(`Check ${email} for your login link.`, true);
    }
  });

  $("signOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

  async function setPassword() {
    const pw = prompt("Set a password for faster sign-in on your other devices (at least 6 characters):");
    if (pw == null) return;
    if (pw.length < 6) { toast("Password must be at least 6 characters"); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (!error) { try { localStorage.setItem("tasktrack.pwPrompted", "1"); } catch (e) {} }
    toast(error ? (error.message || "Could not set password") : "Password set — use it to sign in on any device");
  }
  $("setPwBtn").addEventListener("click", setPassword);

  // One-time nudge: encourage setting a password so other devices don't rely on
  // the (rate-limited) email link.
  function maybePromptPassword() {
    try { if (localStorage.getItem("tasktrack.pwPrompted")) return; } catch (e) { return; }
    if (!$("uploadOverlay").hidden) return;   // don't stack over the upload prompt
    show($("pwPromptOverlay"));
  }
  $("pwPromptLater").addEventListener("click", () => {
    hide($("pwPromptOverlay"));
    try { localStorage.setItem("tasktrack.pwPrompted", "1"); } catch (e) {}
  });
  $("pwPromptSet").addEventListener("click", async () => {
    hide($("pwPromptOverlay"));
    await setPassword();
  });

  function renderAccount() {
    if (!me) return;
    const email = me.email || "";
    const role = ROLE_LABEL[myRole] || myRole;
    const avatar = (email[0] || "?").toUpperCase();
    $("account").hidden = false;
    $("accountEmail").textContent = email;
    $("accountRole").textContent = role;
    $("accountAvatar").textContent = avatar;
    // mobile "More" sheet account
    if ($("mAccountEmail")) {
      $("mAccountEmail").textContent = email;
      $("mAccountRole").textContent = role;
      $("mAccountAvatar").textContent = avatar;
    }
  }

  // ============================================================
  //  Data loads
  // ============================================================
  async function loadRole() {
    try {
      const { data } = await sb.from("memberships").select("role").eq("user_id", me.id).maybeSingle();
      if (data && data.role) myRole = data.role;
    } catch (e) { /* keep default */ }
  }

  async function loadProjects() {
    try {
      const { data, error } = await sb.from("projects").select("*").order("position");
      if (error) throw error;
      projects = (data || []).map(projFromRow);
    } catch (e) { fromCache("projects"); }
  }

  async function loadTasks() {
    try {
      const { data, error } = await sb.from("tasks").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      tasks = (data || []).map(taskFromRow);
    } catch (e) { fromCache("tasks"); }
  }

  async function loadPeople() {
    if (!can.staff()) return;
    try {
      const { data, error } = await sb.from("memberships").select("user_id, role, profiles(email, full_name, avatar_url)");
      if (error) throw error;
      people = (data || []).map((m) => ({
        userId: m.user_id, role: m.role,
        email: m.profiles ? m.profiles.email : "", name: m.profiles ? m.profiles.full_name : "",
      }));
      profilesById = {};
      people.forEach((p) => (profilesById[p.userId] = p));
    } catch (e) { /* non-fatal */ }
  }

  // Label for who raised a request — a public submitter's name (+ department),
  // or a logged-in requester's profile name.
  function requesterLabel(t) {
    if (t.requesterName) return t.requesterName + (t.requesterDept ? " · " + t.requesterDept : "");
    const p = profilesById[t.requesterId];
    return p ? (p.name || p.email || "Someone") : "Someone";
  }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ projects, tasks })); } catch (e) {}
  }
  function fromCache(which) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      if (which === "projects" && Array.isArray(c.projects)) projects = c.projects;
      if (which === "tasks" && Array.isArray(c.tasks)) tasks = c.tasks;
    } catch (e) {}
  }

  const projectById = (id) => projects.find((p) => p.id === id);
  const defaultProject = () => projects.find((p) => p.isDefault) || projects[0];

  // Remember which tasks we've already seen so brand-new office requests can
  // announce themselves with a toast.
  function primeSeen() { seenTaskIds.clear(); tasks.forEach((t) => seenTaskIds.add(t.id)); }
  function detectNewRequests() {
    const fresh = tasks.filter((t) => t.source === "request" && !seenTaskIds.has(t.id));
    tasks.forEach((t) => seenTaskIds.add(t.id));
    if (!fresh.length) return;
    toast(fresh.length === 1 ? `🔔 New request from ${requesterLabel(fresh[0])}` : `🔔 ${fresh.length} new requests`);
  }

  // ============================================================
  //  Realtime
  // ============================================================
  function subscribeRealtime() {
    if (!sb || realtimeChannel) return;
    try {
      realtimeChannel = sb.channel("db-changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (p) => applyChange("task", p))
        .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, (p) => applyChange("project", p))
        .subscribe();
    } catch (e) { /* realtime is best-effort */ }
  }

  function applyChange(kind, payload) {
    const arr = kind === "task" ? tasks : projects;
    const map = kind === "task" ? taskFromRow : projFromRow;
    if (payload.eventType === "DELETE") {
      const id = payload.old.id;
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr.splice(i, 1);
    } else {
      const obj = map(payload.new);
      const i = arr.findIndex((x) => x.id === obj.id);
      if (i >= 0) arr[i] = obj; else arr.unshift(obj);
    }
    if (myRole === "requester") { renderRequests(); return; }
    saveCache();
    render();
    if (kind === "task") detectNewRequests();
  }

  // ============================================================
  //  Date helpers
  // ============================================================
  const todayStr = () => new Date().toISOString().slice(0, 10);
  function dueState(due) {
    if (!due) return "";
    const t = todayStr();
    return due < t ? "overdue" : due === t ? "today" : "future";
  }
  function formatDue(due) {
    if (!due) return "";
    return new Date(due + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // ============================================================
  //  Filtering + rendering  (unchanged view logic)
  // ============================================================
  function visibleTasks() {
    return tasks.filter((t) => {
      if (scope === "today" && dueState(t.due) !== "today") return false;
      if (scope === "overdue" && dueState(t.due) !== "overdue") return false;
      if (scope === "attention" && !t.needsAttention) return false;
      if (scope === "completed" && t.status !== "completed") return false;
      if (scope.startsWith("project:") && t.projectId !== scope.slice(8)) return false;
      if (query) {
        const hay = (t.title + " " + (t.notes || "")).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  function render() {
    renderSidebarProjects();
    updateCounts();
    reflectPermissions();
    if (view === "board") { show(boardView); hide(listView); renderBoard(); }
    else { hide(boardView); show(listView); renderList(); }
  }

  // Hide create/edit affordances for read-only roles (viewer / requester).
  function reflectPermissions() {
    const editor = can.edit();
    $("newTaskBtn").style.display = editor ? "" : "none";
    $("newProjectBtn").style.display = editor ? "" : "none";
    $("peopleBtn").hidden = myRole !== "owner";
    // mobile equivalents
    $("mAddBtn").style.display = editor ? "" : "none";
    $("mNewProjectBtn").style.display = editor ? "" : "none";
    $("mPeopleBtn").hidden = myRole !== "owner";
  }

  function renderSidebarProjects() {
    renderProjectListInto(projectListEl);
    renderProjectListInto(document.getElementById("mProjectList"));
  }

  function renderProjectListInto(el) {
    if (!el) return;
    el.innerHTML = projects.map((p) => {
      const n = tasks.filter((t) => t.projectId === p.id).length;
      const active = scope === "project:" + p.id ? "active" : "";
      const edit = can.edit() ? `<button class="row-edit" data-edit="${p.id}" title="Edit project">⋯</button>` : "";
      return `
        <div class="project-row ${active}">
          <button class="filter-btn project-btn" data-scope="project:${p.id}">
            <span class="dot" style="background:${col(p.color)}"></span>
            <span class="project-name">${esc(p.name)}</span>
            <span class="count">${n}</span>
          </button>
          ${edit}
        </div>`;
    }).join("");
    el.querySelectorAll(".project-btn").forEach((btn) => {
      btn.addEventListener("click", () => { setScope(btn.dataset.scope, btn.querySelector(".project-name").textContent); closeSheet(); });
    });
    el.querySelectorAll(".row-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); closeSheet(); openProjectModal(btn.dataset.edit); });
    });
  }

  function setScope(newScope, title) {
    scope = newScope;
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    const btn = document.querySelector(`.filter-btn[data-scope="${cssEsc(newScope)}"]`);
    if (btn) btn.classList.add("active");
    renderSidebarProjects();
    viewTitle.textContent = title;
    updateMobileNav();
    render();
  }

  function updateMobileNav() {
    document.querySelectorAll(".mnav-btn[data-mscope]").forEach((b) =>
      b.classList.toggle("active", b.dataset.mscope === scope));
  }

  function updateCounts() {
    let today = 0, overdue = 0, attention = 0, completed = 0;
    tasks.forEach((t) => {
      const ds = dueState(t.due);
      if (ds === "today") today++; if (ds === "overdue") overdue++;
      if (t.needsAttention) attention++;
      if (t.status === "completed") completed++;
    });
    setCount("all", tasks.length); setCount("today", today);
    setCount("overdue", overdue); setCount("attention", attention); setCount("completed", completed);
    const badge = $("mAttnBadge");
    if (badge) { badge.textContent = attention; badge.hidden = attention === 0; }
  }
  function setCount(k, n) { const el = document.querySelector(`[data-count="${k}"]`); if (el) el.textContent = n; }

  function projectChip(t) {
    const p = projectById(t.projectId);
    return p ? `<span class="chip project-chip" style="--pc:${col(p.color)}">${esc(p.name)}</span>` : "";
  }

  const requestChip = (t) => t.source === "request" ? `<span class="chip request-chip">📨 ${esc(requesterLabel(t))}</span>` : "";
  const attentionChip = (t) => t.needsAttention ? `<span class="chip attention-chip">⚠ Needs attention</span>` : "";

  function cardMarkup(t) {
    const ds = dueState(t.due);
    const dueChip = t.due ? `<span class="chip due ${ds === "overdue" ? "overdue" : ds === "today" ? "today" : ""}">📅 ${formatDue(t.due)}</span>` : "";
    const notes = t.notes ? `<div class="card-notes">${esc(t.notes)}</div>` : "";
    const drag = can.edit() ? 'draggable="true"' : "";
    return `
      <div class="card prio-${t.priority} ${t.status === "completed" ? "done" : ""} ${t.needsAttention ? "flagged" : ""}" ${drag} data-id="${t.id}">
        <div class="card-title">${esc(t.title)}</div>
        ${notes}
        <div class="card-meta">${attentionChip(t)}${requestChip(t)}${projectChip(t)}<span class="chip prio ${t.priority}">${t.priority}</span>${dueChip}</div>
      </div>`;
  }

  function renderBoard() {
    const list = visibleTasks();
    boardView.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      const cards = items.length ? items.map(cardMarkup).join("") : `<div class="col-empty">No tasks</div>`;
      return `
        <div class="column" data-status="${s.key}">
          <div class="column-head"><span class="status-dot" style="background:${s.color}"></span>${s.label}<span class="col-count">${items.length}</span></div>
          <div class="column-body">${cards}</div>
        </div>`;
    }).join("");
    wireCards(); wireColumns();
  }

  function renderList() {
    const list = visibleTasks();
    if (!list.length) { listView.innerHTML = emptyState(); return; }
    listView.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      if (!items.length) return "";
      const rows = items.map((t) => {
        const ds = dueState(t.due);
        const dueChip = t.due ? `<span class="chip due ${ds === "overdue" ? "overdue" : ds === "today" ? "today" : ""}">📅 ${formatDue(t.due)}</span>` : "";
        return `
          <div class="list-row prio-${t.priority} ${t.status === "completed" ? "done" : ""} ${t.needsAttention ? "flagged" : ""}" data-id="${t.id}">
            <div class="list-check" data-check="${t.id}" title="Toggle complete">✓</div>
            <div class="list-main">
              <div class="list-title">${esc(t.title)}</div>
              ${t.notes ? `<div class="list-sub">${esc(t.notes)}</div>` : ""}
            </div>
            <div class="list-meta">${attentionChip(t)}${requestChip(t)}${projectChip(t)}<span class="chip prio ${t.priority}">${t.priority}</span>${dueChip}</div>
            ${t.status === "completed" && can.edit() ? `<button class="ghost-btn restore-btn" data-restore="${t.id}" title="Bring this task back">↩ Restore</button>` : ""}
          </div>`;
      }).join("");
      return `
        <div class="list-group">
          <div class="list-group-head"><span class="status-dot" style="background:${s.color}"></span>${s.label} <span class="col-count">· ${items.length}</span></div>
          ${rows}
        </div>`;
    }).join("");
    wireList();
  }

  function emptyState() {
    return `<div class="empty-state"><div class="big">🗒️</div><p>${query ? "No tasks match your search." : (can.edit() ? "No tasks here yet. Hit <strong>＋ New task</strong> to add one." : "Nothing to show yet.")}</p></div>`;
  }

  // ============================================================
  //  Cards / list / drag & drop
  // ============================================================
  function wireCards() {
    boardView.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openModal(card.dataset.id));
      if (!can.edit()) return;
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.dataset.id);
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    });
  }

  function wireColumns() {
    if (!can.edit()) return;
    boardView.querySelectorAll(".column").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault(); col.classList.remove("drag-over");
        const id = e.dataTransfer.getData("text/plain");
        const task = tasks.find((t) => t.id === id);
        if (task && task.status !== col.dataset.status) {
          await updateTask(id, { status: col.dataset.status });
          toast(`Moved to ${statusLabel(col.dataset.status)}`);
        }
      });
    });
  }

  function wireList() {
    listView.querySelectorAll(".list-row").forEach((row) => {
      row.addEventListener("click", (e) => { if (!e.target.closest("[data-check]")) openModal(row.dataset.id); });
    });
    listView.querySelectorAll("[data-check]").forEach((chk) => {
      chk.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!can.edit()) { toast("You don't have edit access"); return; }
        const task = tasks.find((t) => t.id === chk.dataset.check);
        if (!task) return;
        await updateTask(task.id, { status: task.status === "completed" ? "pending" : "completed" });
      });
    });
    listView.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await updateTask(btn.dataset.restore, { status: "pending" });
        toast("Task restored to Pending");
      });
    });
  }

  // ============================================================
  //  Task mutations (Supabase)
  // ============================================================
  async function createTask(data) {
    const row = { ...rowFromTask(data), source: "internal", created_by: me.id };
    const { data: inserted, error } = await sb.from("tasks").insert(row).select().single();
    if (error) return failWrite(error);
    upsertLocal(tasks, taskFromRow(inserted)); saveCache(); render();
  }
  async function updateTask(id, patch) {
    const task = tasks.find((t) => t.id === id);
    const merged = { ...task, ...patch };
    // A staff member touching a task counts as attending to it — clear the flag.
    const row = { ...rowFromTask(merged), needs_attention: false };
    const { data: updated, error } = await sb.from("tasks").update(row).eq("id", id).select().single();
    if (error) return failWrite(error);
    upsertLocal(tasks, taskFromRow(updated)); saveCache(); render();
  }
  async function deleteTask(id) {
    const { error } = await sb.from("tasks").delete().eq("id", id);
    if (error) return failWrite(error);
    const i = tasks.findIndex((t) => t.id === id); if (i >= 0) tasks.splice(i, 1);
    saveCache(); render();
  }

  async function createProject(name, color) {
    const row = { name, color, is_default: false, position: projects.length, created_by: me.id };
    const { data, error } = await sb.from("projects").insert(row).select().single();
    if (error) return failWrite(error);
    upsertLocal(projects, projFromRow(data)); saveCache(); render();
  }
  async function updateProject(id, patch) {
    const { data, error } = await sb.from("projects").update(patch).eq("id", id).select().single();
    if (error) return failWrite(error);
    upsertLocal(projects, projFromRow(data)); saveCache(); render();
  }
  async function deleteProject(id) {
    const home = defaultProject();
    if (home) await sb.from("tasks").update({ project_id: home.id }).eq("project_id", id);
    const { error } = await sb.from("projects").delete().eq("id", id);
    if (error) return failWrite(error);
    const i = projects.findIndex((p) => p.id === id); if (i >= 0) projects.splice(i, 1);
    tasks.forEach((t) => { if (t.projectId === id && home) t.projectId = home.id; });
    saveCache(); render();
  }

  function upsertLocal(arr, obj) {
    const i = arr.findIndex((x) => x.id === obj.id);
    if (i >= 0) arr[i] = obj; else arr.unshift(obj);
  }
  function failWrite(error) {
    console.warn("Write failed:", error);
    toast(navigator.onLine ? (error.message || "Could not save") : "You're offline — change not saved");
  }

  // ============================================================
  //  Task modal
  // ============================================================
  const overlay = $("modalOverlay"), form = $("taskForm"), deleteBtn = $("deleteTask"), projectSelect = $("fProject");

  function fillProjectOptions(selectedId) {
    projectSelect.innerHTML = projects.map((p) =>
      `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  }

  function openModal(id) {
    const t = id ? tasks.find((x) => x.id === id) : null;
    if (t && !can.edit()) return;   // read-only roles can't open the editor
    const scoped = scope.startsWith("project:") ? scope.slice(8) : (defaultProject() || {}).id;
    $("modalTitle").textContent = t ? "Edit task" : "New task";
    $("taskId").value = t ? id : "";
    $("fTitle").value = t ? t.title : "";
    $("fNotes").value = t ? t.notes || "" : "";
    fillProjectOptions(t ? t.projectId : scoped);
    $("fPriority").value = t ? t.priority : "medium";
    $("fStatus").value = t ? t.status : "pending";
    $("fDue").value = t ? t.due || "" : "";
    deleteBtn.hidden = !t || !can.delete();
    show(overlay);
    setTimeout(() => $("fTitle").focus(), 30);
  }
  const closeModal = () => hide(overlay);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("taskId").value;
    const data = {
      title: $("fTitle").value.trim(), notes: $("fNotes").value.trim(),
      projectId: projectSelect.value, priority: $("fPriority").value,
      status: $("fStatus").value, due: $("fDue").value,
    };
    if (!data.title) return;
    closeModal();
    if (id) { await updateTask(id, data); toast("Task updated"); }
    else { await createTask(data); toast("Task added"); }
  });

  deleteBtn.addEventListener("click", async () => {
    const id = $("taskId").value;
    if (!id) return;
    closeModal();
    await deleteTask(id);
    toast("Task deleted");
  });

  $("newTaskBtn").addEventListener("click", () => openModal(null));
  $("closeModal").addEventListener("click", closeModal);
  $("cancelTask").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // ============================================================
  //  Project modal
  // ============================================================
  const projectOverlay = $("projectOverlay"), projectForm = $("projectForm");
  const deleteProjectBtn = $("deleteProject"), swatchesEl = $("pSwatches");
  let pickedColor = PALETTE[0];

  function renderSwatches(selected) {
    pickedColor = selected;
    swatchesEl.innerHTML = PALETTE.map((c) =>
      `<button type="button" class="swatch ${c === selected ? "sel" : ""}" data-color="${c}" style="background:${c}"></button>`).join("");
    swatchesEl.querySelectorAll(".swatch").forEach((s) => s.addEventListener("click", () => renderSwatches(s.dataset.color)));
  }

  function openProjectModal(id) {
    const p = id ? projectById(id) : null;
    $("projectModalTitle").textContent = p ? "Edit project" : "New project";
    $("projectId").value = p ? id : "";
    $("pName").value = p ? p.name : "";
    renderSwatches(p ? p.color : PALETTE[projects.length % PALETTE.length]);
    deleteProjectBtn.hidden = !p || p.isDefault;
    show(projectOverlay);
    setTimeout(() => $("pName").focus(), 30);
  }
  const closeProjectModal = () => hide(projectOverlay);

  projectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("projectId").value;
    const name = $("pName").value.trim();
    if (!name) return;
    closeProjectModal();
    if (id) { await updateProject(id, { name, color: pickedColor }); toast("Project updated"); }
    else { await createProject(name, pickedColor); toast("Project created"); }
  });

  deleteProjectBtn.addEventListener("click", async () => {
    const id = $("projectId").value;
    const p = projectById(id);
    if (!p || p.isDefault) return;
    closeProjectModal();
    if (scope === "project:" + id) { scope = "all"; viewTitle.textContent = "All tasks"; }
    await deleteProject(id);
    toast("Project deleted — its tasks moved to the default project");
  });

  $("newProjectBtn").addEventListener("click", () => openProjectModal(null));
  $("closeProject").addEventListener("click", closeProjectModal);
  $("cancelProject").addEventListener("click", closeProjectModal);
  projectOverlay.addEventListener("click", (e) => { if (e.target === projectOverlay) closeProjectModal(); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!projectOverlay.hidden) closeProjectModal();
    else if (!overlay.hidden) closeModal();
  });

  // ============================================================
  //  Sidebar view filters + layout toggle + search
  // ============================================================
  document.querySelectorAll(".filters > .filter-btn").forEach((btn) => {
    if (!btn.dataset.scope) return;   // skip action buttons like "People & roles"
    btn.addEventListener("click", () => setScope(btn.dataset.scope, btn.textContent.trim().replace(/\s*\d+$/, "")));
  });
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active"); view = btn.dataset.view; render();
    });
  });
  searchInput.addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); render(); });

  // ---- Theme (light / dark) ----
  function currentTheme() {
    const set = document.documentElement.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyThemeLabel() {
    const dark = currentTheme() === "dark";
    document.querySelectorAll(".js-theme-toggle").forEach((el) => {
      const emojiOnly = el.classList.contains("theme-top") || el.closest(".portal-account");
      el.textContent = emojiOnly ? (dark ? "☀️" : "🌙") : (dark ? "☀️ Light mode" : "🌙 Dark mode");
    });
  }
  function toggleTheme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("tasktrack.theme", next); } catch (e) {}
    applyThemeLabel();
  }
  document.querySelectorAll(".js-theme-toggle").forEach((el) => el.addEventListener("click", toggleTheme));
  applyThemeLabel();

  // ---- Mobile bottom nav + "More" sheet ----
  const moreSheet = $("moreSheet");
  const SCOPE_TITLE = { all: "All tasks", today: "Due today", overdue: "Overdue", attention: "Needs attention", completed: "Completed log" };
  function openSheet() { renderSidebarProjects(); show(moreSheet); }
  function closeSheet() { if (moreSheet) moreSheet.hidden = true; }

  document.querySelectorAll(".mnav-btn[data-mscope]").forEach((b) => {
    b.addEventListener("click", () => setScope(b.dataset.mscope, SCOPE_TITLE[b.dataset.mscope] || "Tasks"));
  });
  $("mAddBtn").addEventListener("click", () => openModal(null));
  $("mMoreBtn").addEventListener("click", openSheet);
  moreSheet.addEventListener("click", (e) => { if (e.target === moreSheet) closeSheet(); });

  document.querySelectorAll("[data-msheet-scope]").forEach((b) => {
    b.addEventListener("click", () => { setScope(b.dataset.msheetScope, SCOPE_TITLE[b.dataset.msheetScope] || "Tasks"); closeSheet(); });
  });
  $("mNewProjectBtn").addEventListener("click", () => { closeSheet(); openProjectModal(null); });
  $("mPeopleBtn").addEventListener("click", () => { closeSheet(); openPeople(); });
  $("mSetPwBtn").addEventListener("click", () => { closeSheet(); setPassword(); });
  $("mExportBtn").addEventListener("click", () => { closeSheet(); exportBackup(); });
  $("mImportBtn").addEventListener("click", () => { closeSheet(); $("importFile").click(); });
  $("mSignOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

  // ---- Refresh (manual + automatic) ----
  // Realtime should push new requests live, but mobile connections drop; so we
  // also refetch on focus/visibility, poll periodically, and offer a button.
  let refreshing = false;
  async function reloadData(silent) {
    if (!appReady || !me || refreshing) return;
    refreshing = true;
    document.querySelectorAll("#refreshBtn, #portalRefresh").forEach((b) => b.classList.add("spinning"));
    try {
      if (myRole === "requester") { await loadTasks(); renderRequests(); }
      else { await Promise.all([loadTasks(), loadProjects()]); saveCache(); render(); detectNewRequests(); }
      if (!silent) toast("Refreshed");
    } catch (e) {
      if (!silent) toast("Couldn't refresh — check your connection");
    } finally {
      refreshing = false;
      document.querySelectorAll("#refreshBtn, #portalRefresh").forEach((b) => b.classList.remove("spinning"));
    }
  }
  ["refreshBtn", "portalRefresh"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("click", () => reloadData(false));
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadData(true); });
  window.addEventListener("focus", () => reloadData(true));
  window.addEventListener("online", () => reloadData(true));
  setInterval(() => { if (document.visibilityState === "visible") reloadData(true); }, 45000);

  // ============================================================
  //  Export / Import (client-side backup of the current view of data)
  // ============================================================
  function exportBackup() {
    const blob = new Blob([JSON.stringify({ projects, tasks }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `tasktrack-backup-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
    toast("Backup downloaded");
  }
  $("exportBtn").addEventListener("click", exportBackup);
  const importFile = $("importFile");
  $("importBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!can.edit()) { toast("You don't have edit access"); importFile.value = ""; return; }
    try {
      const parsed = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : parsed.tasks;
      if (!Array.isArray(list)) throw new Error("bad format");
      await uploadTasks(list, Array.isArray(parsed.projects) ? parsed.projects : []);
      toast("Tasks imported to your account");
    } catch (err) { toast("Could not read that file"); }
    importFile.value = "";
  });

  // ============================================================
  //  One-time: offer to upload legacy on-device tasks to the cloud
  // ============================================================
  function maybeOfferLocalUpload() {
    if (!can.edit()) return;
    let local = null;
    try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch (e) {}
    if (!local || !Array.isArray(local.tasks) || !local.tasks.length) return;
    if (tasks.length > 0) return;   // cloud already has tasks — don't duplicate
    $("uploadText").textContent =
      `This device has ${local.tasks.length} task(s) saved locally. Upload them to your account so they sync everywhere?`;
    show($("uploadOverlay"));
    $("uploadGo").onclick = async () => {
      hide($("uploadOverlay"));
      await uploadTasks(local.tasks, local.projects || []);
      try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
      toast("Uploaded to your account");
    };
    $("uploadSkip").onclick = () => hide($("uploadOverlay"));
  }

  // Insert a batch of tasks, mapping their projects by name (creating missing ones).
  async function uploadTasks(list, srcProjects) {
    const byName = {}; projects.forEach((p) => (byName[p.name.toLowerCase()] = p.id));
    const srcById = {}; (srcProjects || []).forEach((p) => (srcById[p.id] = p));
    const home = defaultProject();
    for (const t of list) {
      // resolve a project id in *our* workspace
      let projId = home ? home.id : null;
      const src = t.projectId ? srcById[t.projectId] : null;
      const name = src ? src.name : (t.category === "personal" ? "Personal" : null);
      if (name) {
        const key = name.toLowerCase();
        if (!byName[key]) {
          await createProject(name, (src && src.color) || PALETTE[projects.length % PALETTE.length]);
          const np = projects.find((p) => p.name.toLowerCase() === key);
          if (np) byName[key] = np.id;
        }
        projId = byName[key] || projId;
      }
      await createTask({
        title: t.title || "Untitled", notes: t.notes || "", projectId: projId,
        priority: t.priority || "medium", status: t.status || "pending", due: t.due || "",
      });
    }
  }

  // ============================================================
  //  People & roles (Owner only)
  // ============================================================
  const ROLES = ["owner", "delegate", "editor", "viewer", "requester"];
  const peopleOverlay = $("peopleOverlay");

  $("peopleBtn").addEventListener("click", openPeople);
  $("closePeople").addEventListener("click", () => hide(peopleOverlay));
  peopleOverlay.addEventListener("click", (e) => { if (e.target === peopleOverlay) hide(peopleOverlay); });

  let invites = [];

  function openPeople() {
    renderPeople();                 // show what we already have, instantly
    renderInvites();
    show(peopleOverlay);
    // refresh in the background so external changes appear
    loadPeople().then(renderPeople).catch(() => {});
    loadInvites();
  }

  async function loadInvites() {
    try {
      const { data, error } = await sb.from("role_invites").select("*").order("created_at");
      if (error) throw error;
      invites = data || [];
      renderInvites();
    } catch (e) { /* non-owner or offline */ }
  }

  function renderInvites() {
    const el = $("inviteList");
    if (!invites.length) { el.innerHTML = ""; return; }
    el.innerHTML = invites.map((i) => `
      <div class="invite-row">
        <span class="invite-email">${esc(i.email)}</span>
        <span class="invite-role-tag">${ROLE_LABEL[i.role] || i.role}</span>
        <button class="row-edit" data-cancel="${esc(i.email)}" title="Cancel invite">✕</button>
      </div>`).join("");
    el.querySelectorAll("[data-cancel]").forEach((b) =>
      b.addEventListener("click", () => cancelInvite(b.dataset.cancel)));
  }

  $("inviteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("inviteEmail").value.trim().toLowerCase();
    const role = $("inviteRole").value;
    if (!email) return;
    // If they've already signed in, change their role directly instead.
    const existing = people.find((p) => (p.email || "").toLowerCase() === email);
    if (existing) {
      await changeRole(existing.userId, role);
      $("inviteEmail").value = "";
      return;
    }
    // Send an actual invitation email (creates the account + emails a sign-in
    // link) via the invite-user function; the app is invitation-only so this is
    // the only way into the main app.
    const { data, error } = await sb.functions.invoke("invite-user", { body: { email, role } });
    if (error) { toast("Could not send the invite — check the email address and that you're the Owner."); return; }
    $("inviteEmail").value = "";
    invites = invites.filter((i) => i.email !== email).concat([{ email, role, created_at: new Date().toISOString() }]);
    renderInvites();
    if (data && data.alreadyExists) toast(`${email} already has an account — role set to ${ROLE_LABEL[role]}. They can just sign in.`);
    else toast(`Invitation emailed to ${email} (${ROLE_LABEL[role]})`);
    loadInvites();
  });

  async function cancelInvite(email) {
    const { error } = await sb.from("role_invites").delete().eq("email", email);
    if (error) { toast(error.message || "Could not cancel"); return; }
    invites = invites.filter((i) => i.email !== email);
    renderInvites();
    toast("Invite removed");
  }

  function renderPeople() {
    const list = $("peopleList");
    const order = { owner: 0, delegate: 1, editor: 2, viewer: 3, requester: 4 };
    const sorted = [...people].sort((a, b) => (order[a.role] - order[b.role]) || (a.email || "").localeCompare(b.email || ""));
    list.innerHTML = sorted.map((p) => {
      const isMe = p.userId === me.id;
      const opts = ROLES.map((r) => `<option value="${r}" ${p.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("");
      const label = p.name || p.email || "Unknown";
      return `
        <div class="person-row">
          <div class="account-avatar">${esc((label[0] || "?").toUpperCase())}</div>
          <div class="person-info">
            <span class="person-name">${esc(label)}${isMe ? ' <span class="you-tag">you</span>' : ""}</span>
            <span class="person-email">${esc(p.email || "")}</span>
          </div>
          <select class="person-role" data-user="${p.userId}" ${isMe ? "disabled" : ""}>${opts}</select>
        </div>`;
    }).join("");
    list.querySelectorAll(".person-role").forEach((sel) =>
      sel.addEventListener("change", () => changeRole(sel.dataset.user, sel.value)));
  }

  async function changeRole(userId, role) {
    const { error } = await sb.from("memberships")
      .update({ role, updated_by: me.id, updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) { toast(error.message || "Could not update role"); return; }
    const p = people.find((x) => x.userId === userId);
    if (p) { p.role = role; profilesById[userId] = p; }
    toast("Role updated");
  }

  // ============================================================
  //  Requester portal (submit requests, track status, nudge)
  // ============================================================
  $("portalSignOut").addEventListener("click", async () => { await sb.auth.signOut(); });

  $("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("rTitle").value.trim();
    if (!title) return;
    const row = {
      title, notes: $("rNotes").value.trim(), due: $("rDue").value || null,
      priority: $("rPriority").value, status: "pending", source: "request",
      requester_id: me.id, created_by: me.id, project_id: null,
    };
    const { data, error } = await sb.from("tasks").insert(row).select().single();
    if (error) { toast(error.message || "Could not submit request"); return; }
    upsertLocal(tasks, taskFromRow(data));
    e.target.reset();
    renderRequests();
    toast("Request submitted");
  });

  function renderRequests() {
    const list = $("requestList");
    const mine = [...tasks].sort((a, b) => new Date(b.created) - new Date(a.created));
    if (!mine.length) {
      list.innerHTML = `<div class="empty-state"><div class="big">📮</div><p>No requests yet — submit one above.</p></div>`;
      return;
    }
    list.innerHTML = mine.map((t) => {
      const done = t.status === "completed";
      const dueChip = t.due ? `<span class="chip due">📅 ${formatDue(t.due)}</span>` : "";
      const nudged = t.needsAttention ? `<span class="chip attention-chip">Reminder sent</span>` : "";
      return `
        <div class="request-row ${done ? "done" : ""}">
          <div class="request-main">
            <div class="request-title">${esc(t.title)}</div>
            ${t.notes ? `<div class="list-sub">${esc(t.notes)}</div>` : ""}
            <div class="request-meta">
              <span class="status-badge s-${t.status}">${statusLabel(t.status)}</span>
              ${dueChip}${nudged}
            </div>
          </div>
          <button class="ghost-btn nudge-btn" data-nudge="${t.id}" ${done ? "disabled" : ""}>Send Reminder</button>
        </div>`;
    }).join("");
    list.querySelectorAll("[data-nudge]").forEach((b) => b.addEventListener("click", () => nudge(b.dataset.nudge)));
  }

  async function nudge(taskId) {
    const { error } = await sb.from("task_events").insert({ task_id: taskId, user_id: me.id, type: "nudge", message: "Reminder" });
    if (error) { toast(error.message || "Could not send reminder"); return; }
    const t = tasks.find((x) => x.id === taskId);
    if (t) t.needsAttention = true;
    renderRequests();
    toast("Reminder sent — they'll see it flagged");
  }

  // ============================================================
  //  Web Push notifications (device alerts)
  // ============================================================
  function setupNotifications() {
    const btns = [$("notifBtn"), $("mNotifBtn")].filter(Boolean);
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    if (!CFG.vapidPublicKey || !can.edit()) return;   // only people who receive nudges
    if (Notification.permission === "granted") { btns.forEach((b) => (b.hidden = true)); ensureSubscribed(); return; }
    if (Notification.permission === "denied") return;
    btns.forEach((b) => {
      b.hidden = false;
      b.onclick = async () => {
        closeSheet();
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { toast("Notifications not enabled"); return; }
        await ensureSubscribed();
        btns.forEach((x) => (x.hidden = true));
        toast("Notifications enabled on this device");
      };
    });
  }

  async function ensureSubscribed() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(CFG.vapidPublicKey),
        });
      }
      const j = sub.toJSON();
      await sb.from("push_subscriptions").upsert(
        { user_id: me.id, endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent },
        { onConflict: "endpoint" }
      );
    } catch (e) { console.warn("Push subscribe failed:", e); }
  }

  function urlB64ToUint8(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // ============================================================
  //  Utilities
  // ============================================================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
  // Only allow hex colours into inline styles (defuses stored-XSS via a crafted
  // project colour). Anything else falls back to a neutral grey.
  function col(c) { return /^#[0-9a-fA-F]{3,8}$/.test(c || "") ? c : "#94a3b8"; }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
  }

  // ---- Go ----
  boot();
})();
