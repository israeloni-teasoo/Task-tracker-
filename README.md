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

**Hosted (recommended):** once GitHub Pages finishes deploying, the app is live at:

> **https://israeloni-teasoo.github.io/Task-tracker-/**

Open that link in any modern browser and start adding tasks with **＋ New task**.

**Or offline/local:** open **`index.html`** directly in a browser — it still works
(the installable-app and offline features just need the hosted link).

### Install it as an app (free — no App Store, no cost)

It's a **PWA**, so it installs to the home screen and runs full-screen like a
native app, on phones and computers:

- **iPhone / iPad (Safari):** open the link → tap **Share** ⬆️ → **Add to Home Screen**.
- **Samsung / Android (Chrome):** open the link → menu **⋮** → **Add to Home screen** / **Install app**.
- **Desktop (Chrome/Edge):** click the **install** icon in the address bar.

After installing, it opens from its own icon and **works offline** — no internet
needed to view or edit tasks.

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

## Accounts & sync

Sign in with your email (a one-time magic link — no password) and your tasks
live in your account, synced across every device in real time. Open the app on
an iPhone, a Samsung and a laptop and you see the same board; a change on one
shows on the others within seconds.

Roles decide what each person can do (Owner, Delegate, Editor, Viewer,
Requester) — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The first person
to sign in becomes the **Owner**.

Backend setup lives in `backend/` — run `schema.sql` once, then the files in
`backend/migrations/` if you applied the schema before those features were added.

**Offline:** the installed app keeps a local cache so you can still see your
tasks without a connection; edits save once you're back online.

**Backup:** **Export** downloads a JSON copy anytime; **Import** uploads tasks
from a backup into your account.

## Project structure

```
index.html            — markup / layout
styles.css            — styling (light + dark, responsive)
app.js                — all behaviour (auth, cloud sync, board, list, drag & drop)
supabase-config.js    — Supabase URL + publishable key (safe for the browser)
vendor/supabase.js    — Supabase client library (vendored for offline use)
manifest.webmanifest  — PWA metadata (name, icons, colours)
sw.js                 — service worker (offline support)
icons/                — app icons
backend/schema.sql    — database tables, roles & row-level security
backend/migrations/   — incremental DB changes to apply on existing projects
.nojekyll             — serve files as-is on GitHub Pages
```

No build step, no framework. Edit and refresh; pushing to the default branch
redeploys the hosted site automatically.

## Hosting (one-time setup)

The site is served by **GitHub Pages**. To turn it on (once):

1. Go to the repo **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `claude/internal-task-tracker-43ehtk` and folder **`/ (root)`**, then **Save**.

Within ~1 minute the app is live at
**https://israeloni-teasoo.github.io/Task-tracker-/**, and every future push to
that branch republishes it automatically.

## Roadmap: multi-user, sync, roles & office portal

The next phase turns TaskTrack into a shared system with logins, roles &
permissions, cross-device sync, an office request portal, and push
notifications/reminders — all on free infrastructure (Supabase + GitHub Pages).

- **Design & permission model:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Database schema & security policies:** [`backend/schema.sql`](backend/schema.sql)

## Ideas for later

- Recurring tasks
- Subtasks / checklists inside a task
