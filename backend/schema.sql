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

-- Pre-assigned roles by email — lets the Owner grant a role to someone before
-- they have signed in. Consumed by the sign-up trigger below.
create table public.role_invites (
  email      text primary key,
  role       app_role not null default 'requester',
  full_name  text,                                 -- optional name to seed the profile
  invited_by uuid references public.profiles(id) on delete set null,
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
  due             timestamptz,
  assignee_id     uuid references public.profiles(id) on delete set null, -- staff the task is assigned to
  source          task_source not null default 'internal',
  requester_id    uuid references public.profiles(id) on delete set null, -- who asked (logged-in)
  requester_name  text,                                -- who asked (public link, no account)
  requester_department text,
  track_token     uuid default gen_random_uuid(),      -- lets a public submitter check status
  created_by      uuid references public.profiles(id) on delete set null,
  needs_attention boolean not null default false,     -- set by a nudge / overdue job
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index tasks_requester_idx on public.tasks(requester_id);
create index tasks_status_idx    on public.tasks(status);
create index tasks_assignee_idx  on public.tasks(assignee_id);

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

-- Files attached to a task / office request. Bytes live in the Storage bucket
-- 'attachments'; this table holds the metadata.
create table public.task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  path         text not null,
  filename     text not null,
  content_type text,
  size         bigint,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  track_token  uuid,
  created_at   timestamptz not null default now()
);
create index task_attachments_task_idx on public.task_attachments(task_id);

-- Multiple assignees per task, and the recipients a request is directed to.
create table public.task_assignees (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create table public.task_recipients (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

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

-- Server-only config (e.g. the send-push webhook URL + secret). Locked by RLS
-- with no policies, so only security-definer functions / the service role read it.
create extension if not exists pg_net;
create table public.app_settings (
  key   text primary key,
  value text
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
  invited  app_role;
  inv_name text;
begin
  select role, full_name into invited, inv_name from public.role_invites where email = lower(new.email);

  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', inv_name),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  -- First user becomes the Admin (owner); otherwise honour a pre-assigned role
  -- (invite) for this email; otherwise default to Requester.
  if not exists (select 1 from public.memberships where role = 'owner') then
    assigned := 'owner';
  elsif invited is not null then
    assigned := invited;
  end if;
  delete from public.role_invites where email = lower(new.email);

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
  if new.status = 'completed' and (old.status is distinct from 'completed') then
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
-- Fire a push to explicit users (NULL => send-push defaults to owner+delegate).
create or replace function public._fire_push(p_task_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare fn_url text; secret text;
begin
  begin
    select value into fn_url from public.app_settings where key = 'push_fn_url';
    select value into secret from public.app_settings where key = 'push_webhook_secret';
    if fn_url is not null and secret is not null then
      perform net.http_post(
        url := fn_url,
        body := jsonb_build_object('task_id', p_task_id, 'user_ids', to_jsonb(p_user_ids)),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret));
    end if;
  exception when others then null; end;
end; $$;

-- Ask send-push to email the current Owner.
create or replace function public._fire_email_owner(p_subject text, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare fn_url text; secret text; owner_email text;
begin
  begin
    select value into fn_url from public.app_settings where key = 'push_fn_url';
    select value into secret from public.app_settings where key = 'push_webhook_secret';
    select p.email into owner_email from public.memberships m join public.profiles p on p.id = m.user_id
     where m.role = 'owner' limit 1;
    if fn_url is not null and secret is not null and owner_email is not null then
      perform net.http_post(
        url := fn_url,
        body := jsonb_build_object('email', jsonb_build_object('to', owner_email, 'subject', p_subject, 'text', p_text)),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret));
    end if;
  exception when others then null; end;
end; $$;

-- Nudge → flag + push owner/delegate ∪ recipients ∪ assignees.
create or replace function public.flag_on_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
declare targets uuid[];
begin
  if new.type = 'nudge' then
    update public.tasks set needs_attention = true where id = new.task_id;
    begin
      select array_agg(distinct uid) into targets from (
        select user_id uid from public.memberships where role in ('owner', 'delegate')
        union select user_id from public.task_recipients where task_id = new.task_id
        union select user_id from public.task_assignees where task_id = new.task_id
      ) s;
      perform public._fire_push(new.task_id, targets);
    exception when others then null; end;
  end if;
  return new;
end; $$;

drop trigger if exists task_events_nudge on public.task_events;
create trigger task_events_nudge after insert on public.task_events
  for each row execute function public.flag_on_nudge();

-- New office request → push owner/delegate + email the boss.
create or replace function public.on_new_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if new.source = 'request' then
    who := coalesce(
      nullif(trim(new.requester_name), ''),
      (select nullif(trim(full_name), '') from public.profiles where id = new.requester_id),
      (select email from public.profiles where id = new.requester_id),
      'A team member');
    perform public._fire_push(new.id, null);
    perform public._fire_email_owner(
      'New request from ' || who || ': ' || coalesce(new.title, '(untitled)'),
      who || coalesce(' (' || new.requester_department || ')', '')
        || ' submitted a request: ' || coalesce(new.title, ''));
  end if;
  return new;
end; $$;
drop trigger if exists tasks_new_request on public.tasks;
create trigger tasks_new_request after insert on public.tasks
  for each row execute function public.on_new_request();

-- Recipient / assignee added → push that person.
create or replace function public.on_recipient_added()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public._fire_push(new.task_id, array[new.user_id]); return new; end; $$;
drop trigger if exists task_recipients_added on public.task_recipients;
create trigger task_recipients_added after insert on public.task_recipients
  for each row execute function public.on_recipient_added();

create or replace function public.on_assignee_added()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public._fire_push(new.task_id, array[new.user_id]); return new; end; $$;
drop trigger if exists task_assignees_added on public.task_assignees;
create trigger task_assignees_added after insert on public.task_assignees
  for each row execute function public.on_assignee_added();

-- ============================================================================
--  Row-Level Security
-- ============================================================================
alter table public.profiles           enable row level security;
alter table public.memberships         enable row level security;
alter table public.role_invites        enable row level security;
alter table public.projects            enable row level security;
alter table public.tasks               enable row level security;
alter table public.task_events         enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.reminders           enable row level security;
alter table public.task_attachments    enable row level security;
alter table public.task_assignees      enable row level security;
alter table public.task_recipients     enable row level security;
alter table public.app_settings        enable row level security;   -- no policies: server-only

-- profiles: see your own; staff see everyone; you can edit your own.
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_staff());
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- memberships: see your own role; staff see all. Admin (owner) changes any role;
-- the Managing Partner (delegate) may manage everyone except Admins.
create policy memberships_select on public.memberships for select
  using (user_id = auth.uid() or public.is_staff());
create policy memberships_write on public.memberships for all
  using (public.is_owner() or (public.app_current_role() = 'delegate' and role <> 'owner'))
  with check (public.is_owner() or (public.app_current_role() = 'delegate' and role <> 'owner'));

-- role_invites: Admin + Managing Partner manage invites; delegates can't grant Admin.
create policy role_invites_manage on public.role_invites for all
  using (public.is_owner() or public.app_current_role() = 'delegate')
  with check (public.is_owner() or (public.app_current_role() = 'delegate' and role <> 'owner'));

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
  using (
    public.is_staff()
    or requester_id = auth.uid()
    or exists (select 1 from public.task_assignees a where a.task_id = id and a.user_id = auth.uid())
    or exists (select 1 from public.task_recipients r where r.task_id = id and r.user_id = auth.uid())
  );

create policy tasks_insert_staff on public.tasks for insert
  with check (public.can_edit() and created_by = auth.uid());

create policy tasks_insert_request on public.tasks for insert
  with check (
    source = 'request'
    and requester_id = auth.uid()
    and created_by  = auth.uid()
    and status = 'pending'
  );

-- Anonymous public request submissions (the shared office link). Insert only.
create policy tasks_insert_public on public.tasks for insert to anon
  with check (
    source = 'request'
    and requester_id is null
    and created_by is null
    and status = 'pending'
    and project_id is null
    and requester_name is not null
    and char_length(requester_name) between 1 and 120
    and char_length(coalesce(requester_department, '')) <= 120
    and char_length(coalesce(title, '')) between 1 and 300
    and char_length(coalesce(notes, '')) <= 2000
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

-- task_attachments: staff or the request's owner may read; staff insert as self.
create policy att_meta_select on public.task_attachments for select
  using (
    public.is_staff()
    or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
  );
create policy att_meta_insert_staff on public.task_attachments for insert
  with check (public.is_staff() and uploaded_by = auth.uid());

-- task_assignees / task_recipients: staff or the request owner may read;
-- staff manage assignees (editor+) and recipients.
create policy task_assignees_select on public.task_assignees for select
  using (public.is_staff() or user_id = auth.uid()
         or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid()));
create policy task_assignees_write on public.task_assignees for all
  using (public.can_edit()) with check (public.can_edit());
create policy task_recipients_select on public.task_recipients for select
  using (public.is_staff() or user_id = auth.uid()
         or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid()));
create policy task_recipients_write on public.task_recipients for all
  using (public.is_staff()) with check (public.is_staff());

-- push_subscriptions: you manage only your own devices.
create policy push_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- reminders: staff (editor+) manage reminders.
create policy reminders_staff on public.reminders for all
  using (public.can_edit()) with check (public.can_edit());

-- ---------- Public request status lookup (by token, for anon submitters) ----------
create or replace function public.public_request_status(token uuid)
returns table (title text, status task_status, created_at timestamptz, needs_attention boolean)
language sql security definer set search_path = public as $$
  select title, status, created_at, needs_attention
    from public.tasks
   where track_token = token and source = 'request'
   limit 1;
$$;
grant execute on function public.public_request_status(uuid) to anon, authenticated;

-- Public nudge (by token) — lets an accountless submitter raise the flag on
-- their own request. Definer-run; the flag_on_nudge trigger does the flagging.
-- Returns a status string: 'ok' | 'completed' | 'notfound' | 'cooldown'.
-- Rate-limited to one reminder per request every 30 minutes (server-enforced).
create or replace function public.public_nudge(token uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
  st  text;
  last_at timestamptz;
begin
  select id, status::text into tid, st from public.tasks
   where track_token = token and source = 'request'
   limit 1;
  if tid is null then return 'notfound'; end if;
  if st = 'completed' then return 'completed'; end if;

  select max(created_at) into last_at
    from public.task_events
   where task_id = tid and type = 'nudge';
  if last_at is not null and last_at > now() - interval '30 minutes' then
    return 'cooldown';
  end if;

  insert into public.task_events (task_id, user_id, type, message)
  values (tid, null, 'nudge', 'Reminder from requester (public link)');
  return 'ok';
end;
$$;
grant execute on function public.public_nudge(uuid) to anon, authenticated;

-- Public activity thread (by token) + posting a comment as an accountless submitter.
create or replace function public.public_request_events(token uuid)
returns table (type text, message text, created_at timestamptz, author text)
language sql security definer set search_path = public as $$
  select e.type::text, e.message, e.created_at,
         coalesce(p.full_name, p.email,
                  case when e.user_id is null then 'Requester' else 'Staff' end) as author
    from public.task_events e
    join public.tasks t on t.id = e.task_id
    left join public.profiles p on p.id = e.user_id
   where t.track_token = token and t.source = 'request'
     and e.type in ('comment', 'nudge', 'status_change')
   order by e.created_at asc;
$$;
grant execute on function public.public_request_events(uuid) to anon, authenticated;

create or replace function public.public_add_comment(token uuid, body text)
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if body is null or length(trim(body)) = 0 or length(body) > 2000 then return false; end if;
  select id into tid from public.tasks where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  insert into public.task_events (task_id, user_id, type, message) values (tid, null, 'comment', trim(body));
  return true;
end; $$;
grant execute on function public.public_add_comment(uuid, text) to anon, authenticated;

-- Accountless /office attachment upload: record metadata against a request by token.
create or replace function public.public_add_attachment(
  token uuid, p text, fname text, ctype text, fsize bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tasks where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  insert into public.task_attachments (task_id, path, filename, content_type, size, track_token)
  values (tid, p, fname, ctype, fsize, token);
  return true;
end; $$;
grant execute on function public.public_add_attachment(uuid, text, text, text, bigint) to anon, authenticated;

-- Public staff directory (names + role only, no emails) for the office "who is
-- this for?" picker, plus setting a request's recipients by token.
create or replace function public.public_staff()
returns table (id uuid, name text, role text)
language sql security definer set search_path = public as $$
  select p.id, coalesce(nullif(trim(p.full_name), ''), 'Staff member'), m.role::text
    from public.memberships m join public.profiles p on p.id = m.user_id
   where m.role in ('owner','delegate','editor','viewer')
   order by case m.role when 'owner' then 0 when 'delegate' then 1 when 'editor' then 2 else 3 end, p.full_name nulls last;
$$;
grant execute on function public.public_staff() to anon, authenticated;

create or replace function public.public_set_recipients(token uuid, ids uuid[])
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tasks where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  delete from public.task_recipients where task_id = tid;
  insert into public.task_recipients (task_id, user_id)
    select tid, u from unnest(ids) as u
     where exists (select 1 from public.memberships m where m.user_id = u and m.role in ('owner','delegate','editor','viewer'))
  on conflict do nothing;
  return true;
end; $$;
grant execute on function public.public_set_recipients(uuid, uuid[]) to anon, authenticated;

-- ---------- Attachments storage bucket (private) ----------
insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false)
on conflict (id) do nothing;
drop policy if exists att_obj_insert on storage.objects;
create policy att_obj_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'attachments');
drop policy if exists att_obj_select on storage.objects;
create policy att_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments');

-- ---------- Enable realtime (live cross-device sync) ----------
-- Adds these tables to Supabase's realtime publication so the app receives
-- live INSERT/UPDATE/DELETE events. (RLS still governs what each client sees.)
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.task_events;
alter publication supabase_realtime add table public.task_assignees;
alter publication supabase_realtime add table public.task_recipients;

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
