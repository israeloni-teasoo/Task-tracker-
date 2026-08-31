/* ============================================================
   TaskTrack — application logic
   Vanilla JS, no dependencies. State persists in localStorage.
   ============================================================ */

(function () {
  "use strict";

  const STORAGE_KEY = "tasktrack.v1";

  // Board columns, in display order. `key` matches task.status.
  const STATUSES = [
    { key: "pending",    label: "Pending",     color: "var(--s-pending)" },
    { key: "inprogress", label: "In Progress", color: "var(--s-inprogress)" },
    { key: "blocked",    label: "Blocked",     color: "var(--s-blocked)" },
    { key: "onhold",     label: "On Hold",     color: "var(--s-onhold)" },
    { key: "completed",  label: "Completed",   color: "var(--s-completed)" },
  ];
  const statusLabel = (k) => (STATUSES.find((s) => s.key === k) || {}).label || k;

  // ---- State ----
  let tasks = load();
  let scope = "all";        // sidebar filter: all | work | personal | today | overdue
  let view = "board";       // board | list
  let query = "";           // search text

  // ---- Elements ----
  const boardView = document.getElementById("boardView");
  const listView = document.getElementById("listView");
  const viewTitle = document.getElementById("viewTitle");
  const searchInput = document.getElementById("search");
  const toastEl = document.getElementById("toast");

  // ============================================================
  //  Persistence
  // ============================================================
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("Could not read saved tasks:", e);
    }
    return seed();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn("Could not save tasks:", e);
    }
  }

  // A few friendly example tasks on first run, so the board isn't empty.
  function seed() {
    const today = new Date();
    const iso = (offset) => {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    return [
      { id: uid(), title: "Prepare board meeting deck", notes: "Q3 numbers + hiring plan slides.", category: "work", priority: "high", status: "inprogress", due: iso(1), created: Date.now() },
      { id: uid(), title: "Approve marketing budget", notes: "Waiting on finance sign-off.", category: "work", priority: "high", status: "blocked", due: iso(0), created: Date.now() },
      { id: uid(), title: "Reply to investor email", notes: "", category: "work", priority: "medium", status: "pending", due: iso(2), created: Date.now() },
      { id: uid(), title: "Book dentist appointment", notes: "Prefer a morning slot.", category: "personal", priority: "low", status: "pending", due: "", created: Date.now() },
      { id: uid(), title: "Renew car insurance", notes: "Compare 2–3 quotes first.", category: "personal", priority: "medium", status: "onhold", due: iso(5), created: Date.now() },
      { id: uid(), title: "Sign off Q2 report", notes: "", category: "work", priority: "medium", status: "completed", due: iso(-2), created: Date.now() },
    ];
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

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
    const opts = { month: "short", day: "numeric" };
    return d.toLocaleDateString(undefined, opts);
  }

  // ============================================================
  //  Filtering
  // ============================================================
  function visibleTasks() {
    return tasks.filter((t) => {
      // scope
      if (scope === "work" && t.category !== "work") return false;
      if (scope === "personal" && t.category !== "personal") return false;
      if (scope === "today" && dueState(t.due) !== "today") return false;
      if (scope === "overdue" && dueState(t.due) !== "overdue") return false;
      // search
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
    updateCounts();
    if (view === "board") { boardView.hidden = false; listView.hidden = true; renderBoard(); }
    else { boardView.hidden = true; listView.hidden = false; renderList(); }
  }

  function updateCounts() {
    const by = { all: tasks.length, work: 0, personal: 0, today: 0, overdue: 0 };
    tasks.forEach((t) => {
      if (t.category === "work") by.work++;
      if (t.category === "personal") by.personal++;
      if (dueState(t.due) === "today") by.today++;
      if (dueState(t.due) === "overdue") by.overdue++;
    });
    document.querySelectorAll("[data-count]").forEach((el) => {
      el.textContent = by[el.dataset.count] ?? 0;
    });
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
          <span class="chip cat-${t.category}">${t.category === "work" ? "💼 Work" : "🏠 Personal"}</span>
          <span class="chip prio ${t.priority}">${t.priority}</span>
          ${dueChip}
        </div>
      </div>`;
  }

  function renderBoard() {
    const list = visibleTasks();
    boardView.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      const cards = items.length
        ? items.map(cardMarkup).join("")
        : `<div class="col-empty">Drop tasks here</div>`;
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
    if (!list.length) {
      listView.innerHTML = emptyState();
      return;
    }
    // Group by status, keep column order, skip empty groups.
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
              <span class="chip cat-${t.category}">${t.category === "work" ? "💼" : "🏠"}</span>
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
  //  Event wiring — cards / list / drag & drop
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
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const id = e.dataTransfer.getData("text/plain");
        const task = tasks.find((t) => t.id === id);
        if (task && task.status !== col.dataset.status) {
          task.status = col.dataset.status;
          save();
          render();
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
        save();
        render();
      });
    });
  }

  // ============================================================
  //  Modal (create / edit / delete)
  // ============================================================
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("taskForm");
  const deleteBtn = document.getElementById("deleteTask");

  function openModal(id) {
    const editing = Boolean(id);
    const t = editing ? tasks.find((x) => x.id === id) : null;
    document.getElementById("modalTitle").textContent = editing ? "Edit task" : "New task";
    document.getElementById("taskId").value = editing ? id : "";
    document.getElementById("fTitle").value = t ? t.title : "";
    document.getElementById("fNotes").value = t ? t.notes || "" : "";
    document.getElementById("fCategory").value = t ? t.category : (scope === "personal" ? "personal" : "work");
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
      category: document.getElementById("fCategory").value,
      priority: document.getElementById("fPriority").value,
      status: document.getElementById("fStatus").value,
      due: document.getElementById("fDue").value,
    };
    if (!data.title) return;

    if (id) {
      const t = tasks.find((x) => x.id === id);
      Object.assign(t, data);
      toast("Task updated");
    } else {
      tasks.unshift({ id: uid(), created: Date.now(), ...data });
      toast("Task added");
    }
    save();
    render();
    closeModal();
  });

  deleteBtn.addEventListener("click", () => {
    const id = document.getElementById("taskId").value;
    if (!id) return;
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
    closeModal();
    toast("Task deleted");
  });

  document.getElementById("newTaskBtn").addEventListener("click", () => openModal(null));
  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("cancelTask").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

  // ============================================================
  //  Sidebar filters + view toggle + search
  // ============================================================
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      scope = btn.dataset.scope;
      viewTitle.textContent = btn.textContent.trim().replace(/\s*\d+$/, "");
      render();
    });
  });

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      view = btn.dataset.view;
      render();
    });
  });

  searchInput.addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  // ============================================================
  //  Export / Import
  // ============================================================
  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasktrack-backup-${todayStr()}.json`;
    a.click();
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
        if (!Array.isArray(parsed)) throw new Error("bad format");
        tasks = parsed;
        save();
        render();
        toast("Tasks imported");
      } catch (err) {
        toast("Could not read that file");
      }
    };
    reader.readAsText(file);
    importFile.value = "";
  });

  // ============================================================
  //  Utilities
  // ============================================================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
  }

  // ---- Go ----
  render();
})();
