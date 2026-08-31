-- ============================================================================
-- TaskTrack — Supabase database schema
-- Run this in the Supabase SQL editor (Project → SQL editor → New query).
-- It creates the tables, the role model, and the Row-Level Security (RLS)
-- policies that enforce "who can do what" at the database level.
-- ============================================================================

-- ---------- Enums ----------
create type app_role      as enum ('owner', 'delegate', 'editor', 'viewer', 'requester');
create type task_status   as enum ('pending', 'inprogress', 'blocked', 'onhold', 'completed');
create type task_priority as enum ('low', 'medium', 'high');
create type task_source   as enum ('internal', 'request');
create type event_type    as enum ('comment', 'nudge', 'status_change', 'reminder');

-- ---------- Tables ----------

-- One row per signed-in person (mirrors auth.users).
create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text,
  email      text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- One role per person. This is the boss's permission control surface.
create table public.memberships (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  role       app_role not null default 'requester',
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Projects group tasks (e.g. "Work", "Personal", "Board of Directors").
-- Shared across the workspace; staff (editor+) manage them.
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text not null default '#3b82f6',
  is_default boolean not null default false,
  position   int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- At most one default project.
create unique index projects_one_default on public.projects(is_default) where is_default;

-- Tasks (internal) and office requests (source = 'request') share one table.
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  notes           text not null default '',
  project_id      uuid references public.projects(id) on delete set null,
  priority        task_priority not null default 'medium',
  status          task_status not null default 'pending',
  due             date,
  source          task_source not null default 'internal',
  requester_id    uuid references public.profiles(id) on delete set null, -- who asked (portal)
  created_by      uuid references public.profiles(id) on delete set null,
  needs_attention boolean not null default false,     -- set by a nudge / overdue job
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index tasks_requester_idx on public.tasks(requester_id);
create index tasks_status_idx    on public.tasks(status);

-- Comments, nudges, reminders and status-change history on a task.
create table public.task_events (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  type       event_type not null default 'comment',
  message    text,
  created_at timestamptz not null default now()
);
create index task_events_task_idx on public.task_events(task_id);

-- Per-device Web Push subscriptions (one person can have several devices).
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Scheduled reminders (also created automatically for long-pending requests).
create table public.reminders (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  remind_at  timestamptz not null,
  created_by uuid references public.profiles(id) on delete set null,
  sent       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Role helper functions ----------
-- security definer so they read `memberships` without tripping RLS recursion.

create or replace function public.app_current_role()
returns app_role language sql stable security definer set search_path = public as $$
  select role from public.memberships where user_id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_current_role() = 'owner';
$$;

create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_current_role() in ('owner', 'delegate', 'editor');
$$;

create or replace function public.can_delete()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_current_role() in ('owner', 'delegate');
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_current_role() in ('owner', 'delegate', 'editor', 'viewer');
$$;

-- ---------- New-user bootstrap ----------
-- On sign-up, create a profile and give the 'requester' role by default.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned app_role := 'requester';
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  -- The very first person to sign in becomes the Owner (bootstraps the boss);
  -- everyone after that defaults to Requester until the Owner promotes them.
  if not exists (select 1 from public.memberships where role = 'owner') then
    assigned := 'owner';
  end if;

  insert into public.memberships (user_id, role)
  values (new.id, assigned) on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Keep updated_at / completed_at fresh ----------
create or replace function public.touch_task()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'completed' and coalesce(old.status, '') <> 'completed' then
    new.completed_at := now();
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_task();

-- ---------- Flag a task when someone nudges it ----------
-- Lets a requester (who can't update tasks directly) raise the "needs
-- attention" flag by inserting a nudge event. Runs as definer, so it can set
-- the flag regardless of the nudger's row-level permissions.
create or replace function public.flag_on_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'nudge' then
    update public.tasks set needs_attention = true where id = new.task_id;
  end if;
  return new;
end;
$$;

drop trigger if exists task_events_nudge on public.task_events;
create trigger task_events_nudge after insert on public.task_events
  for each row execute function public.flag_on_nudge();

-- ============================================================================
--  Row-Level Security
-- ============================================================================
alter table public.profiles           enable row level security;
alter table public.memberships         enable row level security;
alter table public.projects            enable row level security;
alter table public.tasks               enable row level security;
alter table public.task_events         enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.reminders           enable row level security;

-- profiles: see your own; staff see everyone; you can edit your own.
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_staff());
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- memberships: see your own role; staff see all; only the owner changes roles.
create policy memberships_select on public.memberships for select
  using (user_id = auth.uid() or public.is_staff());
create policy memberships_write on public.memberships for all
  using (public.is_owner()) with check (public.is_owner());

-- projects: any signed-in person may read; staff (editor+) manage them.
create policy projects_select on public.projects for select
  using (auth.uid() is not null);
create policy projects_write on public.projects for all
  using (public.can_edit()) with check (public.can_edit());

-- tasks:
--   read  -> staff see all; a requester sees only their own requests
--   create-> staff create anything; a requester may only create their own request
--   update-> staff (editor+) only  (requesters nudge via task_events instead)
--   delete-> owner / delegate only
create policy tasks_select on public.tasks for select
  using (public.is_staff() or requester_id = auth.uid());

create policy tasks_insert_staff on public.tasks for insert
  with check (public.can_edit() and created_by = auth.uid());

create policy tasks_insert_request on public.tasks for insert
  with check (
    source = 'request'
    and requester_id = auth.uid()
    and created_by  = auth.uid()
    and status = 'pending'
  );

create policy tasks_update_staff on public.tasks for update
  using (public.can_edit()) with check (public.can_edit());

create policy tasks_delete_staff on public.tasks for delete
  using (public.can_delete());

-- task_events: readable by staff or the request's owner; you insert as yourself.
create policy events_select on public.task_events for select
  using (
    public.is_staff()
    or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
  );
create policy events_insert on public.task_events for insert
  with check (
    user_id = auth.uid()
    and (
      public.is_staff()
      or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
    )
  );

-- push_subscriptions: you manage only your own devices.
create policy push_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- reminders: staff (editor+) manage reminders.
create policy reminders_staff on public.reminders for all
  using (public.can_edit()) with check (public.can_edit());

-- ---------- Enable realtime (live cross-device sync) ----------
-- Adds these tables to Supabase's realtime publication so the app receives
-- live INSERT/UPDATE/DELETE events. (RLS still governs what each client sees.)
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.task_events;

-- ---------- Seed the starter projects ----------
insert into public.projects (name, color, is_default, position) values
  ('Work',     '#3b82f6', true,  0),
  ('Personal', '#a855f7', false, 1)
on conflict do nothing;

-- ============================================================================
--  One-time bootstrap: make the boss the Owner
--  After she signs in once, run (replacing the email):
--
--    update public.memberships set role = 'owner'
--    where user_id = (select id from public.profiles where email = 'boss@example.com');
-- ============================================================================
