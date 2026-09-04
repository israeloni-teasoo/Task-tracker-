-- Per-user notification channel preferences (push + email). Idempotent.
create table if not exists public.notification_prefs (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  push       boolean not null default true,
  email      boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;

drop policy if exists notif_prefs_own on public.notification_prefs;
create policy notif_prefs_own on public.notification_prefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
