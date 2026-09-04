# TaskTrack — project context

Internal task/todo tracker + office-request system for a firm's Managing Partner,
replacing ClickUp/Trello. Vanilla HTML/CSS/JS (no framework, no build), installable
as a PWA, backed by Supabase, hosted on Vercel at
`mp-office.teasooconsulting.com`.

_Keep this file current whenever the app changes — it is the source of truth for
project context._

## Stack
- **Frontend:** static `index.html` + `app.js` + `styles.css` (single-page app).
  No bundler. Service worker `sw.js` (network-first app shell, cache-first assets;
  bump `CACHE` on every shippable change). PWA manifest + icons.
- **Backend:** Supabase — Postgres, Auth (email magic-link + password), Row-Level
  Security, Realtime (`postgres_changes`), Storage (private `attachments` bucket),
  Edge Functions (Deno), `pg_net` + `pg_cron`.
- **Hosting:** Vercel (`vercel.json` — security headers incl. strict CSP; the
  Supabase origin is the only allowed `connect-src`).
- **Config:** `supabase-config.js` sets `window.TASKTRACK_SUPABASE` (url,
  anon/publishable key, vapidPublicKey). No secrets in the repo.

## Roles (DB enum `app_role`)
`owner`, `delegate`, `editor`, `viewer`, `requester`.
- **`owner` is displayed as "Admin"** and **`requester` as "Staff"** (display-only
  renames; enum values unchanged). The developer is the Admin / super-admin.
- **The boss = a `delegate`** whose profile name is **"Managing Partner"** (she
  sets this herself on the first-sign-in name+password screen).
- First user to ever sign up becomes `owner` automatically.
- Default role for a new sign-up with no invite = `requester`.
- **People management** (invite / change role / remove) is available to `owner`
  AND `delegate`, but a delegate can never touch an `owner` row or grant `owner`
  (enforced in RLS, migration 016). Invites capture **email + role only** — the
  person sets their own name on first sign-in.

### What each role sees (routing in `continueIntoApp`)
- **owner + delegate → full app** (Kanban board + list of ALL tasks, projects,
  People & roles, Settings).
- **editor / viewer / requester → personal dashboard** (`#portalScreen`):
  "Assigned to me" (editors can change status there), a request form, and
  "My requests". They do NOT see the full team board.

## Auth & invites
- **Invitation-only**, no public page. Sign-ups must be **ON** in Supabase
  (Auth → Providers → Email) so the Admin's invite can create accounts.
- Invite flow (no Edge Function): Admin/Managing Partner enters email + role in
  **People & roles** → app upserts `role_invites` → `signInWithOtp({shouldCreateUser:true})`
  emails a magic link. On first click the person MUST set **name + password**
  (`#pwSetupScreen`); `user_metadata.password_set` marks it done forever, on every
  device. Forgot-password uses `resetPasswordForEmail` → `PASSWORD_RECOVERY`.
- SMTP (Google Workspace App Password) must be configured for reliable invite /
  reset emails — see `docs/AUTH.md`.

## Key features
- Tasks: title, notes, project, priority, status (pending/inprogress/blocked/
  onhold/completed), **due date+time** (`due` is `timestamptz`), **multiple
  assignees** (`task_assignees`), attachments, comment/activity thread
  (`task_events`).
- Requests: staff submit requests and pick **recipients** ("who is this for?",
  `task_recipients`, via `public_staff()` / `public_set_recipients`), optionally
  the Admin. Requesters can send reminders (30-min server-side cooldown in
  `public_nudge`).
- Notifications: in-app flag + toast + Web-Audio chime; **Web Push** via the
  `send-push` Edge Function; **email to the boss** on new requests (via Resend).
  Push reaches owner/delegate + a task's recipients & assignees (triggers in
  migration 014). Device notifications default on for all staff.
- Live sync (Realtime), light/dark theme, offline cache, backup export/import
  (in Settings).

## The `/office` public page was REMOVED
Everyone signs in now. `request.html` / `request.js` deleted and the Vercel
rewrite removed. The `public_*` RPCs that only served anonymous access remain in
the schema but are unused/harmless.

## Database
- **Source of truth:** `backend/schema.sql` (full, for a fresh project).
- **Migrations:** `supabase/migrations/*.sql` (timestamped) are what the GitHub
  Action runs (`scripts/apply-migrations.mjs` via the Management API, using the
  `SUPABASE_ACCESS_TOKEN` secret). `backend/migrations/NNN_*.sql` are paste-style
  mirrors. Migrations are idempotent.
  - 010 rate-limit public nudge · 011 wire push · 012 assignee/due/comments/
    attachments · 013 multi-assignee + recipients + `public_staff` · 014 push to
    recipients + boss email · 015 invite-name + email label + assignee/recipient
    task visibility · 016 delegate can manage people (not Admins) · 017 fix tasks
    RLS infinite recursion (definer helpers) + public_staff email fallback · 018
    notification_prefs (per-user push/email) · 019 new-request email via channel ·
    020 realtime memberships · 021 task participants can read/post comments.
- Notification config lives in the RLS-locked `public.app_settings`
  (`push_fn_url`, `push_webhook_secret`) — never in the repo.

## Edge Functions (`backend/functions/`)
- **`send-push`** — sends Web Push (to explicit `user_ids`, else owner+delegate)
  and, when `email:{to,subject,text}` is passed, emails via **Resend**
  (`RESEND_API_KEY`, `EMAIL_FROM`). Called only by DB triggers holding
  `WEBHOOK_SECRET`. Secrets: VAPID_*, WEBHOOK_SECRET, RESEND_API_KEY.
- `invite-user` — legacy service-role inviter, no longer called by the app.

## Setup checklist (owner/admin, one-time)
1. Apply schema / run the **Apply DB migrations** Action.
2. Auth: enable sign-ups; add the app URL to Redirect URLs; configure SMTP.
3. Deploy `send-push`; set VAPID + `WEBHOOK_SECRET` secrets; insert the two
   `app_settings` rows (see `docs/NOTIFICATIONS.md`).
4. For boss email: set `RESEND_API_KEY` + `EMAIL_FROM` on `send-push`, redeploy.

## Working agreements
- Develop on branch `claude/internal-task-tracker-43ehtk` (the repo's default).
- Bump `sw.js` `CACHE` when shipping front-end changes.
- Keep `backend/schema.sql` and both migration folders in sync with every DB change.
- Update this file whenever the architecture, roles, or setup change.

_Last updated: 2026-09-04._
