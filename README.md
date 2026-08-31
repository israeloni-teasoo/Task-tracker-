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

**Hosted on Vercel.** The repo is connected to Vercel, which deploys the site on
every push to the production branch. Open the Vercel URL
(`https://<your-project>.vercel.app/`) and sign in.

> Set the Vercel **Production Branch** to `claude/internal-task-tracker-43ehtk`
> (the repo's default branch), and add the Vercel URL to Supabase →
> Authentication → **URL Configuration** (Site URL + Redirect URLs) so the login
> link can return to the app.

### Install it as an app (free — no App Store, no cost)

It's a **PWA**, so it installs to the home screen and runs full-screen like a
native app, on phones and computers:

- **iPhone / iPad (Safari):** open the link → tap **Share** ⬆️ → **Add to Home Screen**.
- **Samsung / Android (Chrome):** open the link → menu **⋮** → **Add to Home screen** / **Install app**.
- **Desktop (Chrome/Edge):** click the **install** icon in the address bar.

After installing, it opens from its own icon and works offline for viewing.

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

Sign in once per device and you **stay signed in** — the session persists, so
you won't be asked every time. Two ways to sign in:

- **Password** (default) — instant, no waiting for email.
- **Email link** — a one-time magic link; good for the first sign-in on a new
  device. After using it once, click **🔑 Set a password** in the app so next
  time is instant.

Your tasks live in your account, synced across every device in real time — open
the app on an iPhone, a Samsung and a laptop and a change on one shows on the
others within seconds.

Roles decide what each person can do (Owner, Delegate, Editor, Viewer,
Requester) — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Public office request link

Share **`/request.html`** (e.g. `https://<your-project>.vercel.app/request.html`)
with the office. Anyone can submit a request with their **name** and optional
**department** — no account needed — and it appears on the boss's board tagged
with who asked. Submitters can check the status of their own requests from the
same device. (Backed by an insert-only anon policy; see
`backend/migrations/006_public_requests.sql`.)

## Appearance

A **light/dark toggle** sits at the bottom of the sidebar (and on the request
page). It follows your device theme until you pick one, then remembers it.

## Backend setup

Run `backend/schema.sql` once, then the files in `backend/migrations/` in order
if you applied the schema before those features existed.

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
backend/functions/    — Supabase Edge Function for web push
vercel.json           — Vercel static-hosting config
```

No build step, no framework. Pushing to the production branch redeploys on
Vercel automatically.

## Hosting (Vercel)

The repo is connected to **Vercel**, which serves the static site (no build
command needed). To finish setup:

1. In Vercel → Project → Settings → **Git**, set the **Production Branch** to
   `claude/internal-task-tracker-43ehtk`.
2. Copy the deployment URL (`https://<your-project>.vercel.app/`).
3. In Supabase → Authentication → **URL Configuration**, set the **Site URL** to
   that URL and add it under **Redirect URLs**, so magic-link logins return to
   the app.

Every push to the production branch then redeploys automatically.

## Roles & permissions setup

1. Apply `backend/schema.sql`, then the files in `backend/migrations/` in order.
2. **You sign in first** → you become the **Owner** (for testing/development).
3. Open **People & roles** → add the boss's email and set it to **Owner**. When
   she signs in she becomes an Owner too — multiple Owners are supported, so you
   keep full access. You can also change anyone's role there after they sign in.

## Roadmap

Implemented: logins, cross-device sync, roles & permissions, office request
portal, in-app "needs attention" flags, auto-reminders, and (optional) web push.
All on free infrastructure (Supabase + Vercel).

- **Design & permission model:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Database schema & security policies:** [`backend/schema.sql`](backend/schema.sql)

## Ideas for later

- Recurring tasks
- Subtasks / checklists inside a task
