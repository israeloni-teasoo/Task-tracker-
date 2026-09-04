# TaskTrack

An internal task tracker + office-request system for a firm's Managing Partner,
replacing Trello/ClickUp. A Kanban board and list for the leadership team, and a
personal dashboard for everyone else — with cross-device sync, roles, reminders,
and notifications. Vanilla HTML/CSS/JS (no framework, no build), installable as a
PWA, backed by Supabase, hosted on Vercel.

> Project context for contributors lives in [`CLAUDE.md`](CLAUDE.md) — keep it
> current with every change.

## Who sees what

- **Admin** (the developer) and the **Managing Partner** → the full app: Kanban
  board + list of all tasks, projects, People & roles, Settings.
- **Editor / Viewer / Requester** → a personal dashboard: tasks **assigned to
  me**, a form to **request** something, and **my requests**.

Roles (DB `app_role`): `owner` (shown as **Admin**), `delegate` (the Managing
Partner), `editor`, `viewer`, `requester`. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Accounts & invites

The app is **invitation-only** — everyone signs in.

1. The Admin (or Managing Partner) opens **People & roles**, enters an email and
   picks a role, and clicks **Add**.
2. The person gets an **email magic link**; on first click they set their **name
   and a password**. After that they sign in with email + password.
3. New sign-ups default to **Requester** unless a role was chosen for them.

Sign-ups must be **ON** in Supabase (Auth → Providers → Email) for invites to
create accounts. For reliable invite/reset emails, configure SMTP — see
[`docs/AUTH.md`](docs/AUTH.md). (There is no public `/office` page anymore.)

## Install as an app (PWA, free)

- **iPhone/iPad (Safari):** open the link → **Share** ⬆️ → **Add to Home Screen**.
- **Android/Samsung (Chrome):** menu **⋮** → **Add to Home screen / Install app**.
- **Desktop (Chrome/Edge):** the **install** icon in the address bar.

## Features

- Tasks with title, notes, project, priority, status, **due date + time**,
  **multiple assignees**, attachments, and a per-task **comment/activity thread**.
- Requests: staff submit requests and choose **who they're for** (with the option
  to copy the Admin); reminders with a 30-minute cooldown.
- Notifications: in-app flag + toast + chime; **Web Push** to phones; **email to
  the boss** on new requests. See [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md).
- Real-time sync, light/dark theme, offline cache, and backup export/import
  (in **Settings**).

## Backend setup (one-time)

1. Apply [`backend/schema.sql`](backend/schema.sql) (fresh project) **or** run the
   **Apply DB migrations** GitHub Action to apply `supabase/migrations/*` in order.
2. Auth: enable sign-ups, add the app URL to **Redirect URLs**, configure SMTP.
3. Notifications (optional): deploy the `send-push` Edge Function, set its
   secrets, and insert the two `app_settings` rows — full steps in
   [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md).

## Hosting (Vercel)

The repo is connected to Vercel (static site, no build). Set the **Production
Branch** to `claude/internal-task-tracker-43ehtk`, then add the deployment URL to
Supabase → Authentication → **URL Configuration** (Site URL + Redirect URLs).
Every push to the production branch redeploys automatically. Bump `sw.js`'s
`CACHE` on every front-end change so clients update.

## Project structure

```
index.html            — markup / layout (login, dashboard, full app, modals)
styles.css            — styling (light + dark, responsive)
app.js                — all behaviour (auth, sync, board/list, dashboard, notifications)
supabase-config.js    — Supabase URL + publishable key + VAPID public key
vendor/supabase.js    — Supabase client library (vendored)
manifest.webmanifest  — PWA metadata
sw.js                 — service worker (offline support)
backend/schema.sql    — full database schema, roles & row-level security
supabase/migrations/  — timestamped migrations the Action applies
backend/migrations/   — paste-style mirrors of each migration
backend/functions/    — Supabase Edge Functions (send-push)
vercel.json           — Vercel config + security headers (strict CSP)
docs/                 — AUTH, NOTIFICATIONS, ARCHITECTURE
```

No build step, no framework.
