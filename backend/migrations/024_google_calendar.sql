-- Google Calendar two-way sync scaffolding.
--
-- A user connects their Google Calendar via OAuth (handled by the
-- `google-calendar` Edge Function, which alone holds the refresh token). We keep
-- the sensitive refresh token in a table clients CANNOT read (RLS with no
-- client policies — only the service role reaches it). Pulled events are cached
-- so the calendar view can overlay them, and task<->event links let us push
-- TaskTrack tasks back into Google. Idempotent.

-- ---- Connected accounts (holds the OAuth refresh token — never client-readable)
create table if not exists public.google_accounts (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  email         text,
  refresh_token text not null,
  calendar_id   text not null default 'primary',
  sync_token    text,
  connected_at  timestamptz not null default now()
);
alter table public.google_accounts enable row level security;
-- No client policies on purpose: only the Edge Function (service role, which
-- bypasses RLS) may read/write refresh tokens. Clients learn connection state
-- through google_connection() below, which never exposes the token.

-- ---- Short-lived OAuth "state" nonces (CSRF protection for the callback)
create table if not exists public.google_oauth_states (
  state      uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.google_oauth_states enable row level security;
-- Service-role only (no client policies).

-- ---- Cached Google events (overlaid on the calendar view)
create table if not exists public.google_calendar_events (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  event_id   text not null,
  summary    text,
  starts_at  timestamptz,
  ends_at    timestamptz,
  all_day    boolean not null default false,
  html_link  text,
  updated_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table public.google_calendar_events enable row level security;
-- The connecting user sees their own events; Admin + delegates (the Managing
-- Partner and her PA) see everyone's — same visibility model as office tasks.
drop policy if exists gcal_events_read on public.google_calendar_events;
create policy gcal_events_read on public.google_calendar_events for select
  using (user_id = auth.uid() or public.is_owner() or public.app_current_role() = 'delegate');
-- Writes come only from the Edge Function (service role bypasses RLS).

-- ---- Task <-> Google event links (for push / write-back)
create table if not exists public.task_gcal_links (
  task_id         uuid primary key references public.tasks(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  google_event_id text not null,
  calendar_id     text not null default 'primary',
  updated_at      timestamptz not null default now()
);
alter table public.task_gcal_links enable row level security;
-- Service-role only (internal mapping).

-- ---- Connection status helper (safe: exposes email + bool, never the token)
create or replace function public.google_connection()
returns table(connected boolean, email text)
language sql stable security definer set search_path = public as $$
  select
    exists(select 1 from public.google_accounts g where g.user_id = auth.uid()),
    (select g.email from public.google_accounts g where g.user_id = auth.uid());
$$;
grant execute on function public.google_connection() to authenticated;
