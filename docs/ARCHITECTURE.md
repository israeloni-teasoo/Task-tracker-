# TaskTrack — Architecture & Plan (multi-user)

This document describes how TaskTrack grows from a single-user offline app into
a shared system with **roles & permissions**, an **office request portal**,
**cross-device sync**, and **notifications/reminders** — while staying on free
infrastructure.

## The stack (all free-tier)

| Concern | Choice | Why |
| --- | --- | --- |
| Frontend | The existing PWA (HTML/CSS/JS) | Already built; installs on iOS + Android; works offline |
| Hosting | GitHub Pages | Free, already set up |
| Database + Auth + Realtime | **Supabase** (free tier) | Postgres + logins + row-level security + live sync + scheduled jobs, in one service |
| Push notifications | **Web Push** (VAPID) via a Supabase Edge Function | No third party, no cost; works on installed PWAs (Android, and iOS 16.4+) |
| Scheduled reminders | Supabase `pg_cron` / Scheduled Functions | Flags/pings tasks that sit too long |

The browser app talks directly to Supabase using its **public (anon) key** —
safe to ship in a public site because **Row-Level Security (RLS)** on the
database decides what each signed-in person is allowed to see or do.

## Roles & permissions

Everyone who signs in gets a role. The **Owner (the boss)** is the only one who
can change other people's roles — that's her control panel over "who can do
what". New sign-ins default to **Requester** (the whole office can submit
requests); the boss promotes trusted people (e.g. her PA) to higher roles.

| Capability | Owner (Boss) | Delegate (PA) | Editor | Viewer | Requester (Office) |
| --- | :--: | :--: | :--: | :--: | :--: |
| See all tasks | ✅ | ✅ | ✅ | ✅ | — (only their own requests) |
| Create / edit tasks on her behalf | ✅ | ✅ | ✅ | — | — |
| Move status / complete tasks | ✅ | ✅ | ✅ | — | — |
| Delete tasks | ✅ | ✅ | — | — | — |
| Submit a request to the boss | ✅ | ✅ | ✅ | ✅ | ✅ |
| Track status of their own request | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nudge / remind on their request | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Manage roles & permissions** | ✅ | — | — | — | — |

Roles are stored in the `memberships` table and enforced in the database by RLS
policies (see `backend/schema.sql`), so permissions can't be bypassed from the
browser.

## The office request portal

A shared, sign-in space where anyone in the office can log something they need
from the boss and follow it through:

1. A staff member signs in (Google or email link) and submits a request —
   title, details, optional due date. It lands as a task with
   `source = 'request'` and their name attached.
2. They see **only their own** submitted requests and the **live status**
   (Pending → In Progress → … → Completed).
3. If it's taking too long, they can **Nudge** it — this flags the task in the
   boss's view and (optionally) sends her a push notification, so they don't
   have to physically go and remind her.
4. The boss / PA works the request on the board like any other task; the
   requester sees the status change in real time.

## Notifications & reminders

- **In-app flag (always on):** nudged or overdue tasks show a "Needs attention"
  badge in the boss's view, and updates appear live across her devices.
- **Push notification (opt-in):** when a request is nudged, or a task sits past
  its due date, an Edge Function sends a Web Push to the boss's installed app so
  it pops up on her phone. She can then act (or call the requester back).
- **Auto-reminders:** a scheduled job checks daily for requests pending too long
  and flags/pings them.

> **iOS note (honest caveat):** web push on iPhone works **only** when the app
> has been added to the Home Screen (installed as a PWA) and the phone is on
> iOS 16.4+. On Samsung/Android it works in the browser and installed. The
> in-app "Needs attention" flag works everywhere as a fallback.

## Cross-device sync

Because tasks live in Supabase (not the browser), the boss sees the same board
on her iPhone, her Samsung, and any laptop — and Supabase Realtime pushes
changes live, so a status change on one device shows on the others within
seconds. Offline edits (via the service worker) reconcile when back online.

## Build phases

1. **✅ Phase 0 — done:** offline PWA, board + list, installable, hosted.
2. **Phase 1 — accounts & sync:** wire the app to Supabase; email/Google login;
   tasks sync across devices; boss's role bootstrapped.
3. **Phase 2 — roles UI:** a "People & permissions" screen where the boss
   promotes/demotes users (PA → Delegate, etc.).
4. **Phase 3 — office portal:** request submission + "my requests" tracking +
   nudge.
5. **Phase 4 — notifications:** Web Push + scheduled reminders.

## What I need from you to start Phase 1

Creating the backend needs an account I can't create on the boss's behalf:

1. Create a **free Supabase project** at https://supabase.com (2 minutes).
2. From **Project Settings → API**, send me the **Project URL** and the
   **anon/public key** (both are safe to share — they're meant for the frontend).
3. In the **SQL editor**, run `backend/schema.sql` (I'll guide this, or I can
   refine it first).

I'll then build and test the integration against the real project. The boss's
existing offline tasks can be imported so nothing is lost.
