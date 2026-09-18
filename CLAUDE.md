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
- **People management** (invite / change role / remove): the **People & roles**
  nav entry is shown to **`owner` only** (Admin). RLS still permits `delegate`
  too (migration 016; a delegate can never touch an `owner` row or grant `owner`),
  but the UI entry is Admin-only. Invites capture **email + role only** — the
  person sets their own name on first sign-in.

### What each role sees (routing in `continueIntoApp`)
- **owner + delegate → full app** (Kanban board + list + calendar, projects,
  People & roles, Settings). Three layouts share the same scope/filters via the
  topbar toggle: **Board**, **List**, and **Calendar** (`view` = board/list/
  calendar in `render()`). The Calendar (`renderCalendar()`) has **month / week
  / day / custom-range** modes (`calMode`, `calDate`, `calFrom`/`calTo`). Month/
  week are grids of chips; **Day is a Google-style time grid** (`renderDayGrid`,
  `HOUR_H`, `packColumns` for side-by-side overlaps, all-day strip on top). Task
  chips open the task modal, Google chips open the event modal, clicking an empty
  day (desktop) opens a new task at 9 AM; on mobile month shows dots and tapping a
  day drills into Day view. The calendar overlays the active desk's Google events
  (`loadCalendarEvents` reads the cached `google_calendar_events` for
  `effectiveUid()`). The default **To do**
  view is PERSONAL — only tasks assigned/directed to them or that they created for
  themselves (unassigned); the **All tasks** view is the office-wide list of
  **shared** tasks (assigned to someone, or requests) plus your own — a private
  unassigned personal task stays private to its creator (RLS, migration 028), so
  it never shows in another admin's All tasks. The personal/all **list views also
  surface the active desk's upcoming Google Calendar events** in a "Calendar
  (Google)" group (`gcalListSection`, scopes todo/mine/all). **Office requests**
  is its own scope (`source === "request"`)
  so requests never mix into her personal tasks. `isForMe()` drives To do / My
  tasks; `isMine()` = assignee/recipient only. Adding a task warns (but still
  allows) when another open item is scheduled at the same time (`findConflicts`).
  **Personal delegation (PA feature, migration 025):** any user can name
  delegate(s) in **Settings → My delegates** (`delegations` table). A delegate
  gets **least-privilege** access to ONLY that principal's tasks (RLS:
  `is_delegate_for_task`/`is_delegate_of` grant select/update/delete/insert +
  assignee writes on the principal's tasks) — not the whole office. This is
  independent of the global `delegate` role (which the Managing Partner holds for
  full office access). A user who is anyone's delegate routes into the **full
  app** (RLS keeps their data to their principals' tasks + their own;
  `can.edit()` is true for them), and gets a **"My desk / <principal>'s desk"**
  switcher in the **sidebar footer** listing ONLY their principals (`actingFor`,
  persisted, `effectiveUid()`, `myPrincipals`/`myDelegates`). New tasks while
  managing a desk default to that principal; every write stays authored by the
  real signed-in user (`created_by = me.id`), so it's fully traceable. No
  password sharing / impersonation.
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
    020 realtime memberships · 021 task participants can read/post comments ·
    022 profiles readable by any signed-in user (real author names) · 023
    blocked_users (remove = revoke access; app_current_role null when blocked) ·
    024 Google Calendar sync (`google_accounts` holds the OAuth refresh token,
    server-only/no client RLS; `google_oauth_states`; `google_calendar_events`
    read by owner+delegate; `task_gcal_links`; `google_connection()` helper) ·
    025 personal delegations (`delegations` principal→delegate; `is_delegate_of`/
    `is_delegate_for_task` definer helpers; additive task RLS so a delegate can
    manage ONLY their principal's tasks; each user manages their own in Settings) ·
    026 delegate visibility (task_assignees/task_recipients select + gcal read
    extended with delegation so a switched-in delegate actually sees the desk) ·
    027 gcal_event_meta (platform-only project/priority/status/assignees/notes on
    a Google event, keyed by calendar owner + event id; same audience RLS) ·
    028 private personal tasks (`tasks_select` rewritten with `has_assignees`:
    an unassigned, non-request task is visible only to its creator + their
    delegates; shared/assigned tasks and requests stay office-wide for staff).
- Notification config lives in the RLS-locked `public.app_settings`
  (`push_fn_url`, `push_webhook_secret`) — never in the repo.

## Edge Functions (`backend/functions/`)
- **`send-push`** — sends Web Push (to explicit `user_ids`, else owner+delegate)
  and, when `email:{to,subject,text}` is passed, emails via **Resend**
  (`RESEND_API_KEY`, `EMAIL_FROM`). Called only by DB triggers holding
  `WEBHOOK_SECRET`. Secrets: VAPID_*, WEBHOOK_SECRET, RESEND_API_KEY.
- `invite-user` — legacy service-role inviter, no longer called by the app.
- **Deploying functions:** the **Deploy Edge Function** GitHub Action
  (`.github/workflows/deploy-function.yml`, manual) stages a function from
  `backend/functions/` into `supabase/functions/` and runs
  `supabase functions deploy <name> --no-verify-jwt` with `SUPABASE_ACCESS_TOKEN`
  — browser-only, no local CLI. (Function secrets are set in the Supabase
  dashboard → Edge Functions → Secrets.)
- **`google-calendar`** — two-way Google Calendar sync; holds the OAuth refresh
  token (never sent to the browser). Actions: `start`/`callback` (OAuth connect),
  `pull` (cache Google events for overlay), `push` (mirror a task with a due date
  to the user's primary calendar; removed on complete/delete/undated),
  `disconnect`. Deploy with `--no-verify-jwt`. Secrets: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `APP_URL`. Setup: `docs/GOOGLE-CALENDAR.md`.
  Frontend: Settings → Google Calendar (connect/disconnect); events overlay the
  Calendar view as chips that open an in-app detail modal/drawer
  (`openEventDetail`, `#eventOverlay`) where you can edit title/time, delete, AND
  set **platform-only** project/priority/status/assignees/notes stored in
  `gcal_event_meta` (`gcalMeta`, migration 027) — these don't sync to Google but
  colour the chip by priority; `pushTaskToGcal()` fires on task
  create/update/delete. `findConflicts()` (new-task same-time warning) checks
  BOTH platform tasks AND Google events, so real calendar clashes are caught.
  (Topbar has no refresh button — data auto-refreshes on focus/visibility/poll/
  realtime + the update pill. On mobile, all filters collapse into one **Filters**
  button that opens a bottom sheet.)

## Setup checklist (owner/admin, one-time)
1. Apply schema / run the **Apply DB migrations** Action.
2. Auth: enable sign-ups; add the app URL to Redirect URLs; configure SMTP.
3. Deploy `send-push`; set VAPID + `WEBHOOK_SECRET` secrets; insert the two
   `app_settings` rows (see `docs/NOTIFICATIONS.md`).
4. For boss email: set `RESEND_API_KEY` + `EMAIL_FROM` on `send-push`, redeploy.
5. For Google Calendar: create a Google Cloud OAuth client, deploy
   `google-calendar --no-verify-jwt`, set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
   `APP_URL` (see `docs/GOOGLE-CALENDAR.md`).

## Working agreements
- Develop on branch `claude/internal-task-tracker-43ehtk` (the repo's default).
- Bump `sw.js` `CACHE` when shipping front-end changes.
- Keep `backend/schema.sql` and both migration folders in sync with every DB change.
- Update this file whenever the architecture, roles, or setup change.

_Last updated: 2026-09-15._
