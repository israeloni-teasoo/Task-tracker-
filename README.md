# TaskTrack — a simple personal task & todo tracker

A lightweight, no-fuss task tracker for keeping on top of work **and** home
todos. Built as an alternative to Trello/ClickUp for people who just want to
jot tasks down, see what's due, and drag things across a board — without the
learning curve.

## Why this exists

- **No accounts, no setup.** Open one file and start using it.
- **Board view.** Drag tasks between **Pending → In Progress → Blocked → On Hold → Completed**.
- **Work and personal in one place.** Tag every task as Work 💼 or Personal 🏠 and filter between them.
- **Nothing to lose.** Data is saved in the browser, and you can Export a
  backup file (or Import it on another computer) anytime.

## How to use it

1. Open **`index.html`** in any modern web browser (Chrome, Edge, Safari, Firefox).
2. That's it — start adding tasks with the **＋ New task** button.

To keep a shortcut handy, bookmark the file or add it to the home screen /
taskbar. It works completely offline.

### Everyday actions

| Do this | How |
| --- | --- |
| Add a task | **＋ New task** (top right) |
| Edit a task | Click the task card / row |
| Move a task's status | **Drag** the card between board columns |
| Mark done quickly | Tick the checkbox in **List** view |
| Switch layout | **▦ Board** / **☰ List** toggle |
| Focus on work or home | Sidebar filters (All / Work / Personal / Due today / Overdue) |
| Find a task | Search box (top right) |
| Back up / move devices | **⬇ Export** and **⬆ Import** in the sidebar |

## Views

- **Board** — a Kanban layout. Each column is a status; drag cards to update.
- **List** — a compact, grouped checklist with quick-complete checkboxes.

## Data & privacy

All tasks live in the browser's `localStorage` on the device you're using —
nothing is sent anywhere, and there is no server. Because it's per-browser:

- Use **Export** regularly if the tasks matter, and **Import** to restore or
  move to another machine/browser.
- Clearing browser data for the site will remove the tasks (keep a backup).

## Project structure

```
index.html   — markup / layout
styles.css   — styling (light + dark, responsive)
app.js       — all behaviour (state, board, list, drag & drop, storage)
```

No build step, no dependencies, no framework — just three files. Edit and
refresh.

## Ideas for later

- Recurring tasks and reminders
- Subtasks / checklists inside a task
- Sync across devices (would need a small backend)
- Sharing a board with a PA / assistant
