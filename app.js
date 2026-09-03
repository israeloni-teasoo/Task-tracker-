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
  let assigneesByTask = {}, recipientsByTask = {};   // task_id -> [user_id]
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
    assigneeId: r.assignee_id || "",
    source: r.source, requesterId: r.requester_id, needsAttention: !!r.needs_attention,
    requesterName: r.requester_name || "", requesterDept: r.requester_department || "",
    created: r.created_at,
  });
  const rowFromTask = (t) => ({
    title: t.title, notes: t.notes, project_id: t.projectId || null,
    priority: t.priority, status: t.status, due: t.due || null,
    assignee_id: t.assigneeId || null,
  });
  const projFromRow = (r) => ({ id: r.id, name: r.name, color: r.color, isDefault: r.is_default, position: r.position });

  // ============================================================
  //  Boot & auth
  // ============================================================
  let recoveryMode = false;   // true while handling a password-reset link

  async function boot() {
    if (!sb) { fatal("Cloud config missing. Check supabase-config.js and vendor/supabase.js."); return; }

    // A password-reset link fires PASSWORD_RECOVERY — show the reset form, not the app.
    sb.auth.onAuthStateChange((event, sess) => {
      if (event === "PASSWORD_RECOVERY") { recoveryMode = true; me = sess ? sess.user : me; showPwSetup(true); }
      else if (event === "SIGNED_IN" && sess) { if (!recoveryMode) enterApp(sess); }
      else if (event === "SIGNED_OUT") location.reload();
    });

    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch (e) { /* offline */ }
    // If the URL carries a recovery link, let onAuthStateChange handle it.
    if (/type=recovery/.test(location.hash) || /type=recovery/.test(location.search)) return;
    if (session) await enterApp(session);
    else showAuth();
  }

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function showAuth() {
    hide(bootEl); hide(appEl); hide($("pwSetupScreen")); show(authScreen);
    $("authEmail").focus();
  }

  function fatal(msg) {
    hide(bootEl);
    document.body.insertAdjacentHTML("beforeend",
      `<div class="toast" style="background:#ef4444;color:#fff">${esc(msg)}</div>`);
  }

  // Has this user already chosen a password? Stored in user_metadata so it
  // persists across every device — once set, we never prompt again.
  function hasPassword() {
    const md = (me && me.user_metadata) || {};
    return md.password_set === true;
  }

  async function enterApp(session) {
    if (appReady) return;         // guard against duplicate SIGNED_IN events
    me = session.user;
    hide(authScreen); hide(bootEl);
    await loadRole();

    // Invited users must create a password on first entry (so they're never
    // locked out next time). After it's set, this screen never shows again.
    if (!hasPassword()) { showPwSetup(false); return; }

    continueIntoApp();
  }

  function continueIntoApp() {
    if (appReady) return;
    appReady = true;
    hide($("pwSetupScreen"));

    if (myRole === "requester") {
      // Office staff: the simplified request portal.
      show($("portalScreen"));
      $("portalEmail").textContent = me.email || "";
      loadPortalRecipients();
      loadTasks().then(() => { subscribeRealtime(); renderRequests(); });   // RLS: only their own
      return;
    }

    // Boss / delegate / editor / viewer: the full app.
    show(appEl);
    renderAccount();
    Promise.all([loadProjects(), loadTasks(), loadPeople(), loadAssignees(), loadRecipients()]).then(() => {
      primeSeen();             // seed before realtime so existing requests don't toast
      primeFlagged();          // seed so existing reminders don't chime
      saveCache();
      subscribeRealtime();
      render();
      setupNotifications();
      maybeOfferLocalUpload();
    });
  }

  // ---- Mandatory / reset password screen ----
  function pwSetupMsg(text, ok) {
    const m = $("pwSetupMsg");
    m.hidden = false;
    m.className = "auth-msg " + (ok ? "ok" : "err");
    m.textContent = text;
  }

  function showPwSetup(isRecovery) {
    hide(bootEl); hide(authScreen); hide(appEl); hide($("portalScreen"));
    $("pwSetupTitle").textContent = isRecovery ? "Choose a new password" : "Welcome — set up your account";
    $("pwSetupSub").textContent = isRecovery
      ? "Enter a new password for your account."
      : "Add your name and a password so you can sign back in anytime, on any device.";
    $("pwSetupSubmit").textContent = isRecovery ? "Save new password" : "Save & continue";
    $("pwSetupMsg").hidden = true;
    $("pwNew").value = ""; $("pwNew2").value = "";
    // Name is only collected on first entry, not on a password reset.
    const nameField = $("pwNameField");
    if (nameField) nameField.hidden = !!isRecovery;
    const nameInput = $("pwName");
    if (nameInput) { nameInput.value = (me && me.user_metadata && me.user_metadata.full_name) || ""; nameInput.required = !isRecovery; }
    show($("pwSetupScreen"));
    setTimeout(() => (isRecovery ? $("pwNew") : $("pwName") || $("pwNew")).focus(), 50);
  }

  $("pwSetupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("pwNew").value, pw2 = $("pwNew2").value;
    const name = ($("pwName").value || "").trim();
    if (!recoveryMode && !name) { pwSetupMsg("Please enter your name.", false); return; }
    if (pw.length < 6) { pwSetupMsg("Password must be at least 6 characters.", false); return; }
    if (pw !== pw2) { pwSetupMsg("The two passwords don't match.", false); return; }
    const btn = $("pwSetupSubmit"); const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    const meta = { password_set: true };
    if (!recoveryMode && name) meta.full_name = name;
    const { error } = await sb.auth.updateUser({ password: pw, data: meta });
    btn.disabled = false; btn.textContent = label;
    if (error) { pwSetupMsg(friendlyAuthError(error), false); return; }
    // Persist the name onto their profile row too (used across the app).
    if (!recoveryMode && name && me) { try { await sb.from("profiles").update({ full_name: name }).eq("id", me.id); } catch (_) {} }
    // Refresh the local user so hasPassword() is true from here on.
    try { me = (await sb.auth.getUser()).data.user || me; } catch (_) {}
    if (recoveryMode) {
      recoveryMode = false;
      // Clean the recovery token out of the URL, then enter normally.
      try { history.replaceState(null, "", location.pathname); } catch (_) {}
      const { data } = await sb.auth.getSession();
      appReady = false;
      if (data.session) { await loadRole(); continueIntoApp(); } else showAuth();
    } else {
      continueIntoApp();
    }
  });

  // Escape hatch from the mandatory password screen (wrong account, etc.).
  $("pwSetupSignOut").addEventListener("click", async () => { await sb.auth.signOut(); });

  // ---- Login form ----
  let authMode = "password";   // "password" | "link"

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      authMode = tab.dataset.mode;
      const pw = authMode === "password";
      $("passwordField").hidden = !pw;
      $("forgotPw").hidden = !pw;
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

  // Turn Supabase's raw auth errors into plain, friendly guidance.
  function friendlyAuthError(error) {
    const msg = (error && error.message) || "";
    const low = msg.toLowerCase();
    if (low.includes("invalid login") || low.includes("invalid credentials"))
      return "That email or password isn't right. If you've never set a password, use “Forgot password?” to create one.";
    if (low.includes("not allowed") || low.includes("signups not allowed") || low.includes("signup is disabled"))
      return "Access to the app is by invitation only. Ask the Owner to invite your email — meanwhile the office request page is open to everyone.";
    if (low.includes("email not confirmed"))
      return "Please open the invitation link we emailed you first, then set your password.";
    if (low.includes("rate limit"))
      return "Too many emails for now — please wait about an hour, or sign in with your password.";
    if (low.includes("user not found"))
      return "We couldn't find an account for that email. Ask the Owner to invite you.";
    return msg || "Something went wrong. Please try again.";
  }

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim();
    if (!email) return;
    const btn = $("authSubmit");

    if (authMode === "password") {
      const password = $("authPassword").value;
      if (!password) { authMsg("Enter your password, or use “Forgot password?” to create one.", false); return; }
      btn.disabled = true; btn.textContent = "Signing in…";
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false; btn.textContent = "Sign in";
      if (error) authMsg(friendlyAuthError(error), false);
      // success -> onAuthStateChange handles entering the app
    } else {
      btn.disabled = true; btn.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.href.split("#")[0] },
      });
      btn.disabled = false; btn.textContent = "Send me a login link";
      if (error) authMsg(friendlyAuthError(error), false);
      else authMsg(`Check ${email} for your login link.`, true);
    }
  });

  // ---- Forgot password: email a reset link ----
  $("forgotPw").addEventListener("click", async () => {
    const email = $("authEmail").value.trim();
    if (!email) { authMsg("Enter your email above first, then tap “Forgot password?”.", false); $("authEmail").focus(); return; }
    const btn = $("forgotPw"); btn.disabled = true;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
    btn.disabled = false;
    if (error) authMsg(friendlyAuthError(error), false);
    else authMsg(`We've emailed ${email} a link to reset your password.`, true);
  });

  $("signOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

  // Change password from inside the app (already signed in).
  async function setPassword() {
    const pw = prompt("Enter a new password (at least 6 characters):");
    if (pw == null) return;
    if (pw.length < 6) { toast("Password must be at least 6 characters"); return; }
    const { error } = await sb.auth.updateUser({ password: pw, data: { password_set: true } });
    if (!error) { try { me = (await sb.auth.getUser()).data.user || me; } catch (_) {} }
    toast(error ? (friendlyAuthError(error) || "Could not set password") : "Password updated — use it to sign in on any device");
  }
  $("setPwBtn").addEventListener("click", setPassword);

  // ---- Settings modal ----
  function openSettings() { closeSheet && closeSheet(); reflectNotifState(); show($("settingsOverlay")); }
  function closeSettings() { hide($("settingsOverlay")); }
  $("settingsBtn").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  $("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });

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

  function groupByTask(rows) {
    const m = {};
    (rows || []).forEach((r) => { (m[r.task_id] = m[r.task_id] || []).push(r.user_id); });
    return m;
  }
  async function loadAssignees() {
    try { const { data } = await sb.from("task_assignees").select("task_id, user_id"); assigneesByTask = groupByTask(data); } catch (e) {}
  }
  async function loadRecipients() {
    try { const { data } = await sb.from("task_recipients").select("task_id, user_id"); recipientsByTask = groupByTask(data); } catch (e) {}
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

  // Reminders: play a chime when a task becomes freshly flagged for attention
  // (someone tapped "Send Reminder" on /office). Only the boss/editors hear it.
  let flaggedTaskIds = new Set();
  function primeFlagged() {
    flaggedTaskIds = new Set(tasks.filter((t) => t.needsAttention).map((t) => t.id));
  }
  function detectReminders() {
    const now = new Set(tasks.filter((t) => t.needsAttention).map((t) => t.id));
    let fresh = 0;
    now.forEach((id) => { if (!flaggedTaskIds.has(id)) fresh++; });
    flaggedTaskIds = now;
    if (fresh > 0 && can.edit()) {
      playChime();
      toast(fresh === 1 ? "🔔 A reminder was sent for a task" : `🔔 ${fresh} reminders received`);
    }
  }

  // ---- Reminder chime (Web Audio, no asset needed) ----
  let audioCtx = null, audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      audioUnlocked = true;
    } catch (e) { /* ignore */ }
  }
  // Browsers require a user gesture before audio can play.
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, unlockAudio, { once: false, passive: true }));

  function playChime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const ctx = audioCtx, now = ctx.currentTime;
      // Two quick rising tones — a gentle "ding-dong".
      [[880, 0], [1174.66, 0.18]].forEach(([freq, at]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.4);
      });
    } catch (e) { /* audio not available */ }
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
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_events" }, (p) => {
          // Refresh the activity thread live if its task's modal is open.
          if (openTaskId && p.new && p.new.task_id === openTaskId && overlay && !overlay.hidden) loadThread(openTaskId);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "task_assignees" }, () => { loadAssignees().then(render); })
        .on("postgres_changes", { event: "*", schema: "public", table: "task_recipients" }, () => { loadRecipients().then(render); })
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
    if (kind === "task") { detectNewRequests(); detectReminders(); }
  }

  // ============================================================
  //  Date helpers
  // ============================================================
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // `due` may be a plain date (legacy) or a full timestamp. Classify by local day.
  function dueDayStr(due) {
    if (!due) return "";
    const d = new Date(due);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function dueState(due) {
    const ds = dueDayStr(due);
    if (!ds) return "";
    const t = todayStr();
    return ds < t ? "overdue" : ds === t ? "today" : "future";
  }
  function dueHasTime(due) {
    const d = new Date(due);
    return !isNaN(d) && !(d.getHours() === 0 && d.getMinutes() === 0);
  }
  function formatDue(due) {
    if (!due) return "";
    const d = new Date(due);
    if (isNaN(d)) return "";
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return dueHasTime(due) ? `${date} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : date;
  }
  // Convert a stored due value <-> the <input type="datetime-local"> string.
  function toInputDateTime(due) {
    if (!due) return "";
    const d = new Date(due);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function fromInputDateTime(val) {
    if (!val) return "";
    const d = new Date(val);
    return isNaN(d) ? "" : d.toISOString();
  }

  // ============================================================
  //  Filtering + rendering  (unchanged view logic)
  // ============================================================
  function visibleTasks() {
    return tasks.filter((t) => {
      if (scope === "mine" && !isMine(t)) return false;
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
    let today = 0, overdue = 0, attention = 0, completed = 0, mine = 0;
    tasks.forEach((t) => {
      const ds = dueState(t.due);
      if (ds === "today") today++; if (ds === "overdue") overdue++;
      if (t.needsAttention) attention++;
      if (t.status === "completed") completed++;
      if (isMine(t)) mine++;
    });
    setCount("all", tasks.length); setCount("today", today); setCount("mine", mine);
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
  // "My tasks" = assigned to me, or a request directed to me.
  function isMine(t) {
    const uid = me && me.id;
    if (!uid) return false;
    return (assigneesByTask[t.id] || []).includes(uid) || (recipientsByTask[t.id] || []).includes(uid);
  }
  const nameOf = (id) => { const p = profilesById[id]; return p ? (p.name || p.email || "User") : "User"; };
  function multiLabel(ids) {
    const names = ids.map(nameOf);
    return names.length <= 1 ? (names[0] || "") : `${names[0]} +${names.length - 1}`;
  }
  function assigneeChip(t) {
    const ids = assigneesByTask[t.id] || [];
    if (!ids.length) return "";
    return `<span class="chip assignee-chip" title="Assigned: ${esc(ids.map(nameOf).join(", "))}">👤 ${esc(multiLabel(ids))}</span>`;
  }
  function recipientChip(t) {
    if (t.source !== "request") return "";
    const ids = recipientsByTask[t.id] || [];
    if (!ids.length) return "";
    return `<span class="chip recipient-chip" title="Requested from: ${esc(ids.map(nameOf).join(", "))}">📩 ${esc(multiLabel(ids))}</span>`;
  }

  function cardMarkup(t) {
    const ds = dueState(t.due);
    const dueChip = t.due ? `<span class="chip due ${ds === "overdue" ? "overdue" : ds === "today" ? "today" : ""}">📅 ${formatDue(t.due)}</span>` : "";
    const notes = t.notes ? `<div class="card-notes">${esc(t.notes)}</div>` : "";
    const drag = can.edit() ? 'draggable="true"' : "";
    return `
      <div class="card prio-${t.priority} ${t.status === "completed" ? "done" : ""} ${t.needsAttention ? "flagged" : ""}" ${drag} data-id="${t.id}">
        <div class="card-title">${esc(t.title)}</div>
        ${notes}
        <div class="card-meta">${attentionChip(t)}${assigneeChip(t)}${recipientChip(t)}${requestChip(t)}${projectChip(t)}<span class="chip prio ${t.priority}">${t.priority}</span>${dueChip}</div>
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
            <div class="list-meta">${attentionChip(t)}${assigneeChip(t)}${recipientChip(t)}${requestChip(t)}${projectChip(t)}<span class="chip prio ${t.priority}">${t.priority}</span>${dueChip}</div>
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
    if (error) { failWrite(error); return null; }
    upsertLocal(tasks, taskFromRow(inserted)); saveCache(); render();
    return inserted.id;
  }

  // Persist the multi-assignee set for a task (diff insert/delete).
  async function setTaskAssignees(taskId, ids) {
    const cur = assigneesByTask[taskId] || [];
    const toAdd = ids.filter((x) => !cur.includes(x));
    const toDel = cur.filter((x) => !ids.includes(x));
    try {
      if (toAdd.length) await sb.from("task_assignees").insert(toAdd.map((u) => ({ task_id: taskId, user_id: u })));
      if (toDel.length) await sb.from("task_assignees").delete().eq("task_id", taskId).in("user_id", toDel);
    } catch (e) { console.warn("assignee save failed", e); }
    assigneesByTask[taskId] = ids.slice();
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

  // Only people who can act on tasks can be assignees. Multi-select checkboxes.
  function fillAssigneeOptions(selectedIds) {
    const chosen = new Set(selectedIds || []);
    const assignable = people.filter((p) => ["owner", "delegate", "editor"].includes(p.role));
    if (!assignable.length) { $("fAssignees").innerHTML = `<span class="check-empty">No staff to assign yet.</span>`; return; }
    $("fAssignees").innerHTML = assignable.map((p) => {
      const name = p.name || p.email || "User";
      return `<label class="check-item"><input type="checkbox" value="${p.userId}" ${chosen.has(p.userId) ? "checked" : ""} /> <span>${esc(name)}</span></label>`;
    }).join("");
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
    fillAssigneeOptions(t ? (assigneesByTask[t.id] || []) : []);
    $("fPriority").value = t ? t.priority : "medium";
    $("fStatus").value = t ? t.status : "pending";
    $("fDue").value = t ? toInputDateTime(t.due) : "";
    deleteBtn.hidden = !t || !can.delete();
    // Attachments + activity only apply to an already-saved task.
    const extra = $("taskExtra");
    if (t) { extra.hidden = false; loadThread(t.id); loadAttachments(t.id); }
    else { extra.hidden = true; }
    show(overlay);
    setTimeout(() => $("fTitle").focus(), 30);
  }
  const closeModal = () => { hide(overlay); openTaskId = null; };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("taskId").value;
    const data = {
      title: $("fTitle").value.trim(), notes: $("fNotes").value.trim(),
      projectId: projectSelect.value, priority: $("fPriority").value,
      status: $("fStatus").value, due: fromInputDateTime($("fDue").value),
    };
    if (!data.title) return;
    const assignees = Array.from(document.querySelectorAll('#fAssignees input:checked')).map((c) => c.value);
    closeModal();
    if (id) {
      await updateTask(id, data);
      await setTaskAssignees(id, assignees);
      render();
      toast("Task updated");
    } else {
      const newId = await createTask(data);
      if (newId) { await setTaskAssignees(newId, assignees); render(); }
      toast("Task added");
    }
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
  //  Task activity thread + attachments (edit modal)
  // ============================================================
  let openTaskId = null;

  function eventAuthor(ev) {
    if (!ev.user_id) return "Requester";
    const p = profilesById[ev.user_id];
    return p ? (p.name || p.email || "Staff") : "Staff";
  }
  function eventLine(ev) {
    const when = new Date(ev.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (ev.type === "nudge")
      return `<div class="thread-item sys"><span class="thread-meta">🔔 Reminder sent · ${esc(when)}</span></div>`;
    if (ev.type === "status_change")
      return `<div class="thread-item sys"><span class="thread-meta">${esc(ev.message || "Status changed")} · ${esc(when)}</span></div>`;
    return `<div class="thread-item"><div class="thread-head"><span class="thread-author">${esc(eventAuthor(ev))}</span><span class="thread-meta">${esc(when)}</span></div><div class="thread-msg">${esc(ev.message || "")}</div></div>`;
  }
  async function loadThread(taskId) {
    openTaskId = taskId;
    const box = $("threadList");
    box.innerHTML = `<div class="thread-empty">Loading…</div>`;
    try {
      const { data, error } = await sb.from("task_events").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
      if (error) throw error;
      if (openTaskId !== taskId) return;   // modal moved on
      renderThread(data || []);
    } catch (e) { box.innerHTML = `<div class="thread-empty">Couldn't load activity.</div>`; }
  }
  function renderThread(events) {
    const box = $("threadList");
    if (!events.length) { box.innerHTML = `<div class="thread-empty">No activity yet.</div>`; return; }
    box.innerHTML = events.map(eventLine).join("");
    box.scrollTop = box.scrollHeight;
  }
  async function sendComment() {
    const input = $("threadInput"); const body = input.value.trim();
    if (!body || !openTaskId) return;
    input.value = "";
    const { error } = await sb.from("task_events").insert({ task_id: openTaskId, user_id: me.id, type: "comment", message: body });
    if (error) { toast(error.message || "Couldn't post comment"); input.value = body; return; }
    loadThread(openTaskId);
  }
  $("threadSend").addEventListener("click", sendComment);
  $("threadInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendComment(); } });

  async function loadAttachments(taskId) {
    const box = $("attList");
    box.innerHTML = `<div class="thread-empty">Loading…</div>`;
    try {
      const { data, error } = await sb.from("task_attachments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
      if (error) throw error;
      renderAttachments(data || []);
    } catch (e) { box.innerHTML = `<div class="thread-empty">Couldn't load files.</div>`; }
  }
  function renderAttachments(list) {
    const box = $("attList");
    if (!list.length) { box.innerHTML = `<div class="thread-empty">No files yet.</div>`; return; }
    box.innerHTML = list.map((a) =>
      `<button type="button" class="att-item" data-path="${esc(a.path)}" data-name="${esc(a.filename)}">📄 <span class="att-name">${esc(a.filename)}</span><span class="att-size">${esc(fmtSize(a.size))}</span></button>`).join("");
    box.querySelectorAll(".att-item").forEach((b) => b.addEventListener("click", () => downloadAttachment(b.dataset.path)));
  }
  function fmtSize(n) {
    if (!n) return "";
    const kb = n / 1024;
    return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }
  async function downloadAttachment(path) {
    try {
      const { data, error } = await sb.storage.from("attachments").createSignedUrl(path, 120);
      if (error || !data) { toast("Couldn't open file"); return; }
      window.open(data.signedUrl, "_blank", "noopener");
    } catch (e) { toast("Couldn't open file"); }
  }
  $("attInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !openTaskId) return;
    if (file.size > 10 * 1024 * 1024) { toast("File too large (max 10 MB)"); return; }
    toast("Uploading…");
    const safe = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${openTaskId}/${Date.now()}-${safe}`;
    const { error: upErr } = await sb.storage.from("attachments").upload(path, file, {
      contentType: file.type || "application/octet-stream", upsert: false,
    });
    if (upErr) { toast(upErr.message || "Upload failed"); return; }
    const { error } = await sb.from("task_attachments").insert({
      task_id: openTaskId, path, filename: file.name, content_type: file.type, size: file.size, uploaded_by: me.id,
    });
    if (error) { toast(error.message || "Saved file but couldn't record it"); return; }
    toast("File added");
    loadAttachments(openTaskId);
  });

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
  $("mSettingsBtn").addEventListener("click", () => { closeSheet(); openSettings(); });
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
      toast(`Role updated to ${ROLE_LABEL[role]}`);
      return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    // 1) Record the chosen role so the sign-up trigger applies it on first sign-in.
    const { error: invErr } = await sb.from("role_invites").upsert(
      { email, role, invited_by: me.id }, { onConflict: "email" });
    if (invErr) { if (btn) btn.disabled = false; toast(invErr.message || "Couldn't save the invite — are you the Owner?"); return; }
    // 2) Email a magic link that creates their account (needs sign-ups ON in Supabase).
    const { error } = await sb.auth.signInWithOtp({
      email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + "/" },
    });
    if (btn) btn.disabled = false;
    // Either way the role is saved; keep it on the pending list so it's visible.
    invites = invites.filter((i) => i.email !== email).concat([{ email, role, created_at: new Date().toISOString() }]);
    renderInvites();
    if (error) {
      const low = (error.message || "").toLowerCase();
      if (low.includes("signups not allowed") || low.includes("not allowed") || low.includes("disabled"))
        toast("Enable “Allow new users to sign up” in Supabase → Auth → Providers → Email, then invite again. The role is saved.");
      else if (low.includes("rate limit"))
        toast("Email rate limit hit — set up SMTP (see docs/AUTH.md), then re-invite. The role is saved.");
      else toast(error.message || "Couldn't send the invite email. The role is saved.");
      return;
    }
    $("inviteEmail").value = "";
    toast(`Invitation emailed to ${email} (${ROLE_LABEL[role]})`);
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
      const isOwner = myRole === "owner";
      // The Owner may remove anyone but themselves; other roles can't remove.
      const canRemove = isOwner && !isMe;
      const opts = ROLES.map((r) => `<option value="${r}" ${p.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("");
      const label = p.name || p.email || "Unknown";
      return `
        <div class="person-row">
          <div class="account-avatar">${esc((label[0] || "?").toUpperCase())}</div>
          <div class="person-info">
            <span class="person-name">${esc(label)}${isMe ? ' <span class="you-tag">you</span>' : ""}</span>
            <span class="person-email">${esc(p.email || "")}</span>
          </div>
          <select class="person-role" data-user="${p.userId}" ${isMe || !isOwner ? "disabled" : ""}>${opts}</select>
          ${canRemove ? `<button class="icon-btn danger" data-remove="${p.userId}" title="Remove access">✕</button>` : ""}
        </div>`;
    }).join("");
    list.querySelectorAll(".person-role").forEach((sel) =>
      sel.addEventListener("change", () => changeRole(sel.dataset.user, sel.value)));
    list.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => removePerson(b.dataset.remove)));
  }

  async function removePerson(userId) {
    const p = people.find((x) => x.userId === userId);
    const who = p ? (p.name || p.email || "this user") : "this user";
    if (!confirm(`Remove ${who}'s access to the app? They'll be limited to the public office request page. You can re-invite them anytime.`)) return;
    const { error } = await sb.from("memberships").delete().eq("user_id", userId);
    if (error) { toast(error.message || "Could not remove access"); return; }
    // Also drop any pre-assigned role so a fresh invite is required to return.
    if (p && p.email) { try { await sb.from("role_invites").delete().eq("email", p.email); } catch (e) {} }
    people = people.filter((x) => x.userId !== userId);
    delete profilesById[userId];
    renderPeople();
    toast(`${who} removed from the app`);
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

  // Populate the "Who is this for?" picker in the logged-in requester portal.
  async function loadPortalRecipients() {
    const box = $("rRecipients");
    if (!box) return;
    try {
      const { data } = await sb.rpc("public_staff");
      const staff = data || [];
      if (!staff.length) { box.innerHTML = `<span class="check-empty">No staff listed yet — your request goes to the whole office.</span>`; return; }
      box.innerHTML = staff.map((s) => {
        const tag = s.role === "owner" ? " (Boss)" : "";
        return `<label class="check-item"><input type="checkbox" value="${esc(s.id)}" /> <span>${esc(s.name)}${tag}</span></label>`;
      }).join("");
    } catch (e) { box.innerHTML = `<span class="check-empty">Couldn't load staff — your request goes to the whole office.</span>`; }
  }

  $("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("rTitle").value.trim();
    if (!title) return;
    const recipientIds = Array.from(document.querySelectorAll('#rRecipients input:checked')).map((c) => c.value);
    const row = {
      title, notes: $("rNotes").value.trim(), due: fromInputDateTime($("rDue").value) || null,
      priority: $("rPriority").value, status: "pending", source: "request",
      requester_id: me.id, created_by: me.id, project_id: null,
    };
    const { data, error } = await sb.from("tasks").insert(row).select().single();
    if (error) { toast(error.message || "Could not submit request"); return; }
    if (recipientIds.length && data && data.track_token) {
      try { await sb.rpc("public_set_recipients", { token: data.track_token, ids: recipientIds }); } catch (_) {}
    }
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
      // Completed requests get no reminder button at all. Otherwise the button
      // is disabled while a reminder is still pending or within the cooldown.
      const wait = reminderWaitMs(t);
      let btn = "";
      if (!done) {
        const blocked = t.needsAttention || wait > 0;
        const label = t.needsAttention ? "Reminder sent"
          : wait > 0 ? `Try again in ${Math.ceil(wait / 60000)}m`
          : "Send Reminder";
        btn = `<button class="ghost-btn nudge-btn" data-nudge="${t.id}" ${blocked ? "disabled" : ""}>${label}</button>`;
      }
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
          ${btn}
        </div>`;
    }).join("");
    list.querySelectorAll("[data-nudge]").forEach((b) => b.addEventListener("click", () => nudge(b.dataset.nudge)));
  }

  // A requester can send at most one reminder per task per hour (and none while
  // one is still pending). Returns ms left in the cooldown, or 0 if clear.
  const REMINDER_COOLDOWN_MS = 30 * 60 * 1000;   // 30 minutes (matches /office)
  function reminderWaitMs(t) {
    try {
      const last = Number(localStorage.getItem("tasktrack.nudge." + t.id) || 0);
      const left = REMINDER_COOLDOWN_MS - (Date.now() - last);
      return left > 0 ? left : 0;
    } catch (e) { return 0; }
  }

  async function nudge(taskId) {
    const t = tasks.find((x) => x.id === taskId);
    if (t && (t.status === "completed" || t.needsAttention || reminderWaitMs(t) > 0)) return;
    const { error } = await sb.from("task_events").insert({ task_id: taskId, user_id: me.id, type: "nudge", message: "Reminder" });
    if (error) { toast(error.message || "Could not send reminder"); return; }
    try { localStorage.setItem("tasktrack.nudge." + taskId, String(Date.now())); } catch (e) {}
    if (t) t.needsAttention = true;
    renderRequests();
    toast("Reminder sent — they'll see it flagged");
  }

  // ============================================================
  //  Web Push notifications (device alerts)
  // ============================================================
  function notifSupported() {
    return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window) && !!CFG.vapidPublicKey;
  }

  function setupNotifications() {
    reflectNotifState();
    if (!notifSupported() || !can.staff()) return;
    if (Notification.permission === "granted") { ensureSubscribed(); return; }
    // On by default: ask once automatically the first time a staff member enters
    // (harmless if the browser requires a gesture — the Settings toggle remains).
    if (Notification.permission === "default") {
      let asked = false;
      try { asked = !!localStorage.getItem("tasktrack.notifAsked"); } catch (e) {}
      if (!asked) {
        try { localStorage.setItem("tasktrack.notifAsked", "1"); } catch (e) {}
        enableNotifications(true);
      }
    }
  }

  async function enableNotifications(silent) {
    if (!notifSupported()) { if (!silent) toast("This browser can't do device notifications"); return; }
    let perm;
    try { perm = await Notification.requestPermission(); } catch (e) { return; }
    if (perm !== "granted") { if (!silent) toast("Allow notifications in your browser to turn them on"); reflectNotifState(); return; }
    await ensureSubscribed();
    reflectNotifState();
    if (!silent) toast("Notifications on for this device");
  }

  // Keep the Settings row + mobile button in sync with the browser's state.
  function reflectNotifState() {
    const supported = notifSupported() && can.staff();
    const perm = ("Notification" in window) ? Notification.permission : "unsupported";
    const status = $("notifStatus"), btn = $("notifBtn"), mBtn = $("mNotifBtn");
    if (status) {
      status.textContent = !supported ? "Not available for your role on this device."
        : perm === "granted" ? "On — you'll get a push when a reminder comes in."
        : perm === "denied" ? "Blocked in your browser. Allow notifications in site settings to turn on."
        : "Get a push on this device when a reminder comes in.";
    }
    if (btn) { btn.hidden = !supported || perm === "granted" || perm === "denied"; btn.onclick = () => enableNotifications(false); }
    if (mBtn) { mBtn.hidden = !supported || perm !== "default"; mBtn.onclick = () => { if (typeof closeSheet === "function") closeSheet(); enableNotifications(false); }; }
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
