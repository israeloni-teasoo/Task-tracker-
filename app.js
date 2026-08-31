/* ============================================================
   TaskTrack — application logic
   Vanilla JS, no dependencies. State persists in localStorage.
   Tasks belong to Projects (default: "Work").
   ============================================================ */

(function () {
  "use strict";

  const STORAGE_KEY = "tasktrack.v2";
  const OLD_KEY = "tasktrack.v1";

  // Board columns, in display order. `key` matches task.status.
  const STATUSES = [
    { key: "pending",    label: "Pending",     color: "var(--s-pending)" },
    { key: "inprogress", label: "In Progress", color: "var(--s-inprogress)" },
    { key: "blocked",    label: "Blocked",     color: "var(--s-blocked)" },
    { key: "onhold",     label: "On Hold",     color: "var(--s-onhold)" },
    { key: "completed",  label: "Completed",   color: "var(--s-completed)" },
  ];
  const statusLabel = (k) => (STATUSES.find((s) => s.key === k) || {}).label || k;

  // Colour palette offered when creating a project.
  const PALETTE = ["#3b82f6", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899", "#6366f1"];

  // ---- State ----
  let store = load();            // { projects: [...], tasks: [...] }
  let projects = store.projects;
  let tasks = store.tasks;
  let scope = "all";             // all | today | overdue | project:<id>
  let view = "list";             // list | board  (list is the default)
  let query = "";

  // ---- Elements ----
  const boardView = document.getElementById("boardView");
  const listView = document.getElementById("listView");
  const viewTitle = document.getElementById("viewTitle");
  const searchInput = document.getElementById("search");
  const toastEl = document.getElementById("toast");
  const projectListEl = document.getElementById("projectList");

  // ============================================================
  //  Persistence + migration
  // ============================================================
  function load() {
    // v2 (projects) format
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.tasks)) {
          return normalize(parsed);
        }
      }
    } catch (e) { console.warn("Could not read saved data:", e); }

    // migrate a v1 (category-based) list if present
    try {
      const old = localStorage.getItem(OLD_KEY);
      if (old) {
        const oldTasks = JSON.parse(old);
        if (Array.isArray(oldTasks)) return migrateV1(oldTasks);
      }
    } catch (e) { console.warn("Could not migrate old data:", e); }

    return seed();
  }

  // Ensure every task points at a real project; guarantee a default project.
  function normalize(data) {
    if (!data.projects.length) data.projects = defaultProjects();
    if (!data.projects.some((p) => p.isDefault)) data.projects[0].isDefault = true;
    const ids = new Set(data.projects.map((p) => p.id));
    const def = defaultProjectId(data.projects);
    data.tasks.forEach((t) => { if (!ids.has(t.projectId)) t.projectId = def; });
    return data;
  }

  function migrateV1(oldTasks) {
    const projs = defaultProjects();   // Work (default) + Personal
    const workId = projs[0].id, personalId = projs[1].id;
    const migrated = oldTasks.map((t) => ({
      id: t.id || uid(),
      title: t.title,
      notes: t.notes || "",
      projectId: t.category === "personal" ? personalId : workId,
      priority: t.priority || "medium",
      status: t.status || "pending",
      due: t.due || "",
      created: t.created || Date.now(),
    }));
    return { projects: projs, tasks: migrated };
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects, tasks })); }
    catch (e) { console.warn("Could not save:", e); }
  }

  function defaultProjects() {
    return [
      { id: uid(), name: "Work", color: "#3b82f6", isDefault: true },
      { id: uid(), name: "Personal", color: "#a855f7", isDefault: false },
    ];
  }
  function defaultProjectId(list) {
    const p = (list || projects).find((x) => x.isDefault) || (list || projects)[0];
    return p ? p.id : null;
  }
  const projectById = (id) => projects.find((p) => p.id === id);

  // First-run sample data so the board isn't empty.
  function seed() {
    const projs = defaultProjects();
    const workId = projs[0].id, personalId = projs[1].id;
    const today = new Date();
    const iso = (o) => { const d = new Date(today); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };
    const tasks = [
      { id: uid(), title: "Prepare board meeting deck", notes: "Q3 numbers + hiring plan slides.", projectId: workId, priority: "high", status: "inprogress", due: iso(1), created: Date.now() },
      { id: uid(), title: "Approve marketing budget", notes: "Waiting on finance sign-off.", projectId: workId, priority: "high", status: "blocked", due: iso(0), created: Date.now() },
      { id: uid(), title: "Reply to investor email", notes: "", projectId: workId, priority: "medium", status: "pending", due: iso(2), created: Date.now() },
      { id: uid(), title: "Book dentist appointment", notes: "Prefer a morning slot.", projectId: personalId, priority: "low", status: "pending", due: "", created: Date.now() },
      { id: uid(), title: "Renew car insurance", notes: "Compare 2–3 quotes first.", projectId: personalId, priority: "medium", status: "onhold", due: iso(5), created: Date.now() },
      { id: uid(), title: "Sign off Q2 report", notes: "", projectId: workId, priority: "medium", status: "completed", due: iso(-2), created: Date.now() },
    ];
    return { projects: projs, tasks };
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ============================================================
  //  Date helpers
  // ============================================================
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function dueState(due) {
    if (!due) return "";
    const t = todayStr();
    if (due < t) return "overdue";
    if (due === t) return "today";
    return "future";
  }
  function formatDue(due) {
    if (!due) return "";
    const d = new Date(due + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // ============================================================
  //  Filtering
  // ============================================================
  function visibleTasks() {
    return tasks.filter((t) => {
      if (scope === "today" && dueState(t.due) !== "today") return false;
      if (scope === "overdue" && dueState(t.due) !== "overdue") return false;
      if (scope.startsWith("project:") && t.projectId !== scope.slice(8)) return false;
      if (query) {
        const hay = (t.title + " " + (t.notes || "")).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  // ============================================================
  //  Rendering
  // ============================================================
  function render() {
    renderSidebarProjects();
    updateCounts();
    if (view === "board") { boardView.hidden = false; listView.hidden = true; renderBoard(); }
    else { boardView.hidden = true; listView.hidden = false; renderList(); }
  }

  function renderSidebarProjects() {
    projectListEl.innerHTML = projects.map((p) => {
      const n = tasks.filter((t) => t.projectId === p.id).length;
      const active = scope === "project:" + p.id ? "active" : "";
      return `
        <div class="project-row ${active}" data-project="${p.id}">
          <button class="filter-btn project-btn" data-scope="project:${p.id}">
            <span class="dot" style="background:${p.color}"></span>
            <span class="project-name">${esc(p.name)}</span>
            <span class="count">${n}</span>
          </button>
          <button class="row-edit" data-edit="${p.id}" title="Edit project" aria-label="Edit project">⋯</button>
        </div>`;
    }).join("");

    projectListEl.querySelectorAll(".project-btn").forEach((btn) => {
      btn.addEventListener("click", () => setScope(btn.dataset.scope, btn.querySelector(".project-name").textContent));
    });
    projectListEl.querySelectorAll(".row-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); openProjectModal(btn.dataset.edit); });
    });
  }

  function setScope(newScope, title) {
    scope = newScope;
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    const btn = document.querySelector(`.filter-btn[data-scope="${cssEsc(newScope)}"]`);
    if (btn) btn.classList.add("active");
    renderSidebarProjects();
    viewTitle.textContent = title;
    render();
  }

  function updateCounts() {
    let today = 0, overdue = 0;
    tasks.forEach((t) => {
      const ds = dueState(t.due);
      if (ds === "today") today++;
      if (ds === "overdue") overdue++;
    });
    setCount("all", tasks.length);
    setCount("today", today);
    setCount("overdue", overdue);
  }
  function setCount(key, n) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = n;
  }

  function projectChip(t) {
    const p = projectById(t.projectId);
    if (!p) return "";
    return `<span class="chip project-chip" style="--pc:${p.color}">${esc(p.name)}</span>`;
  }

  function cardMarkup(t) {
    const ds = dueState(t.due);
    const dueChip = t.due
      ? `<span class="chip due ${ds === "overdue" ? "overdue" : ds === "today" ? "today" : ""}">📅 ${formatDue(t.due)}</span>`
      : "";
    const notes = t.notes ? `<div class="card-notes">${esc(t.notes)}</div>` : "";
    return `
      <div class="card prio-${t.priority} ${t.status === "completed" ? "done" : ""}" draggable="true" data-id="${t.id}">
        <div class="card-title">${esc(t.title)}</div>
        ${notes}
        <div class="card-meta">
          ${projectChip(t)}
          <span class="chip prio ${t.priority}">${t.priority}</span>
          ${dueChip}
        </div>
      </div>`;
  }

  function renderBoard() {
    const list = visibleTasks();
    boardView.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      const cards = items.length ? items.map(cardMarkup).join("") : `<div class="col-empty">Drop tasks here</div>`;
      return `
        <div class="column" data-status="${s.key}">
          <div class="column-head">
            <span class="status-dot" style="background:${s.color}"></span>
            ${s.label}
            <span class="col-count">${items.length}</span>
          </div>
          <div class="column-body">${cards}</div>
        </div>`;
    }).join("");
    wireCards();
    wireColumns();
  }

  function renderList() {
    const list = visibleTasks();
    if (!list.length) { listView.innerHTML = emptyState(); return; }
    listView.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      if (!items.length) return "";
      const rows = items.map((t) => {
        const ds = dueState(t.due);
        const dueChip = t.due
          ? `<span class="chip due ${ds === "overdue" ? "overdue" : ds === "today" ? "today" : ""}">📅 ${formatDue(t.due)}</span>`
          : "";
        return `
          <div class="list-row prio-${t.priority} ${t.status === "completed" ? "done" : ""}" data-id="${t.id}">
            <div class="list-check" data-check="${t.id}" title="Toggle complete">✓</div>
            <div class="list-main">
              <div class="list-title">${esc(t.title)}</div>
              ${t.notes ? `<div class="list-sub">${esc(t.notes)}</div>` : ""}
            </div>
            <div class="list-meta">
              ${projectChip(t)}
              <span class="chip prio ${t.priority}">${t.priority}</span>
              ${dueChip}
            </div>
          </div>`;
      }).join("");
      return `
        <div class="list-group">
          <div class="list-group-head">
            <span class="status-dot" style="background:${s.color}"></span>
            ${s.label} <span class="col-count">· ${items.length}</span>
          </div>
          ${rows}
        </div>`;
    }).join("");
    wireList();
  }

  function emptyState() {
    return `
      <div class="empty-state">
        <div class="big">🗒️</div>
        <p>${query ? "No tasks match your search." : "No tasks here yet. Hit <strong>＋ New task</strong> to add one."}</p>
      </div>`;
  }

  // ============================================================
  //  Cards / list / drag & drop
  // ============================================================
  function wireCards() {
    boardView.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openModal(card.dataset.id));
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.dataset.id);
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    });
  }

  function wireColumns() {
    boardView.querySelectorAll(".column").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const id = e.dataTransfer.getData("text/plain");
        const task = tasks.find((t) => t.id === id);
        if (task && task.status !== col.dataset.status) {
          task.status = col.dataset.status;
          save(); render();
          toast(`Moved to ${statusLabel(col.dataset.status)}`);
        }
      });
    });
  }

  function wireList() {
    listView.querySelectorAll(".list-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-check]")) return;
        openModal(row.dataset.id);
      });
    });
    listView.querySelectorAll("[data-check]").forEach((chk) => {
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        const task = tasks.find((t) => t.id === chk.dataset.check);
        if (!task) return;
        task.status = task.status === "completed" ? "pending" : "completed";
        save(); render();
      });
    });
  }

  // ============================================================
  //  Task modal
  // ============================================================
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("taskForm");
  const deleteBtn = document.getElementById("deleteTask");
  const projectSelect = document.getElementById("fProject");

  function fillProjectOptions(selectedId) {
    projectSelect.innerHTML = projects
      .map((p) => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`)
      .join("");
  }

  function openModal(id) {
    const editing = Boolean(id);
    const t = editing ? tasks.find((x) => x.id === id) : null;
    // Default project = the currently-filtered project, else the default (Work).
    const scopedProject = scope.startsWith("project:") ? scope.slice(8) : defaultProjectId();
    document.getElementById("modalTitle").textContent = editing ? "Edit task" : "New task";
    document.getElementById("taskId").value = editing ? id : "";
    document.getElementById("fTitle").value = t ? t.title : "";
    document.getElementById("fNotes").value = t ? t.notes || "" : "";
    fillProjectOptions(t ? t.projectId : scopedProject);
    document.getElementById("fPriority").value = t ? t.priority : "medium";
    document.getElementById("fStatus").value = t ? t.status : "pending";
    document.getElementById("fDue").value = t ? t.due || "" : "";
    deleteBtn.hidden = !editing;
    overlay.hidden = false;
    setTimeout(() => document.getElementById("fTitle").focus(), 30);
  }
  function closeModal() { overlay.hidden = true; }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("taskId").value;
    const data = {
      title: document.getElementById("fTitle").value.trim(),
      notes: document.getElementById("fNotes").value.trim(),
      projectId: projectSelect.value,
      priority: document.getElementById("fPriority").value,
      status: document.getElementById("fStatus").value,
      due: document.getElementById("fDue").value,
    };
    if (!data.title) return;
    if (id) {
      Object.assign(tasks.find((x) => x.id === id), data);
      toast("Task updated");
    } else {
      tasks.unshift({ id: uid(), created: Date.now(), ...data });
      toast("Task added");
    }
    save(); render(); closeModal();
  });

  deleteBtn.addEventListener("click", () => {
    const id = document.getElementById("taskId").value;
    if (!id) return;
    tasks = tasks.filter((t) => t.id !== id);
    store.tasks = tasks;
    save(); render(); closeModal();
    toast("Task deleted");
  });

  document.getElementById("newTaskBtn").addEventListener("click", () => openModal(null));
  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("cancelTask").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // ============================================================
  //  Project modal (create / edit / delete)
  // ============================================================
  const projectOverlay = document.getElementById("projectOverlay");
  const projectForm = document.getElementById("projectForm");
  const deleteProjectBtn = document.getElementById("deleteProject");
  const swatchesEl = document.getElementById("pSwatches");
  let pickedColor = PALETTE[0];

  function renderSwatches(selected) {
    pickedColor = selected;
    swatchesEl.innerHTML = PALETTE.map((c) =>
      `<button type="button" class="swatch ${c === selected ? "sel" : ""}" data-color="${c}" style="background:${c}" aria-label="colour"></button>`
    ).join("");
    swatchesEl.querySelectorAll(".swatch").forEach((s) => {
      s.addEventListener("click", () => renderSwatches(s.dataset.color));
    });
  }

  function openProjectModal(id) {
    const editing = Boolean(id);
    const p = editing ? projectById(id) : null;
    document.getElementById("projectModalTitle").textContent = editing ? "Edit project" : "New project";
    document.getElementById("projectId").value = editing ? id : "";
    document.getElementById("pName").value = p ? p.name : "";
    renderSwatches(p ? p.color : PALETTE[projects.length % PALETTE.length]);
    // The default project (Work) can't be deleted — it's the fallback home for tasks.
    deleteProjectBtn.hidden = !editing || (p && p.isDefault);
    projectOverlay.hidden = false;
    setTimeout(() => document.getElementById("pName").focus(), 30);
  }
  function closeProjectModal() { projectOverlay.hidden = true; }

  projectForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("projectId").value;
    const name = document.getElementById("pName").value.trim();
    if (!name) return;
    if (id) {
      const p = projectById(id);
      p.name = name; p.color = pickedColor;
      toast("Project updated");
    } else {
      projects.push({ id: uid(), name, color: pickedColor, isDefault: false });
      toast("Project created");
    }
    save(); render(); closeProjectModal();
  });

  deleteProjectBtn.addEventListener("click", () => {
    const id = document.getElementById("projectId").value;
    const p = projectById(id);
    if (!p || p.isDefault) return;
    const home = defaultProjectId();
    // Move this project's tasks back to the default project so none are orphaned.
    tasks.forEach((t) => { if (t.projectId === id) t.projectId = home; });
    projects = projects.filter((x) => x.id !== id);
    store.projects = projects;
    if (scope === "project:" + id) { scope = "all"; viewTitle.textContent = "All tasks"; }
    save(); render(); closeProjectModal();
    toast("Project deleted — its tasks moved to the default project");
  });

  document.getElementById("newProjectBtn").addEventListener("click", () => openProjectModal(null));
  document.getElementById("closeProject").addEventListener("click", closeProjectModal);
  document.getElementById("cancelProject").addEventListener("click", closeProjectModal);
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
    btn.addEventListener("click", () => setScope(btn.dataset.scope, btn.textContent.trim().replace(/\s*\d+$/, "")));
  });

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      view = btn.dataset.view;
      render();
    });
  });

  searchInput.addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); render(); });

  // ============================================================
  //  Export / Import
  // ============================================================
  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ projects, tasks }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `tasktrack-backup-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
    toast("Backup downloaded");
  });

  const importFile = document.getElementById("importFile");
  document.getElementById("importBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        let next;
        if (Array.isArray(parsed)) next = migrateV1(parsed);              // old array backup
        else if (parsed && Array.isArray(parsed.tasks)) next = normalize({ // new backup
          projects: Array.isArray(parsed.projects) && parsed.projects.length ? parsed.projects : defaultProjects(),
          tasks: parsed.tasks,
        });
        else throw new Error("bad format");
        store = next; projects = next.projects; tasks = next.tasks;
        scope = "all"; viewTitle.textContent = "All tasks";
        save(); render();
        toast("Tasks imported");
      } catch (err) { toast("Could not read that file"); }
    };
    reader.readAsText(file);
    importFile.value = "";
  });

  // ============================================================
  //  Utilities
  // ============================================================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Escape a value for use inside a CSS attribute selector.
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
  }

  // ---- Go ----
  render();
})();
