-- Multiple assignees per task + request recipients ("who to request from"),
-- plus a public staff directory for the office picker. Idempotent.

-- ── Multiple assignees ──────────────────────────────────────────────────────
create table if not exists public.task_assignees (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
alter table public.task_assignees enable row level security;
drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select
  using (
    public.is_staff() or user_id = auth.uid()
    or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
  );
drop policy if exists task_assignees_write on public.task_assignees;
create policy task_assignees_write on public.task_assignees for all
  using (public.can_edit()) with check (public.can_edit());

-- ── Request recipients (who the request is directed to) ─────────────────────
create table if not exists public.task_recipients (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
alter table public.task_recipients enable row level security;
drop policy if exists task_recipients_select on public.task_recipients;
create policy task_recipients_select on public.task_recipients for select
  using (
    public.is_staff() or user_id = auth.uid()
    or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
  );
drop policy if exists task_recipients_write on public.task_recipients;
create policy task_recipients_write on public.task_recipients for all
  using (public.is_staff()) with check (public.is_staff());

-- Realtime (guarded: adding an already-present table raises otherwise).
do $$
begin
  begin alter publication supabase_realtime add table public.task_assignees; exception when others then null; end;
  begin alter publication supabase_realtime add table public.task_recipients; exception when others then null; end;
end $$;

-- ── Public staff directory (for the accountless /office recipient picker) ───
-- Returns display names + role only — never emails — so anonymous office users
-- can choose who to send a request to without leaking contact details.
create or replace function public.public_staff()
returns table (id uuid, name text, role text)
language sql security definer set search_path = public as $$
  select p.id,
         coalesce(nullif(trim(p.full_name), ''), 'Staff member') as name,
         m.role::text as role
    from public.memberships m
    join public.profiles p on p.id = m.user_id
   where m.role in ('owner', 'delegate', 'editor', 'viewer')
   order by case m.role when 'owner' then 0 when 'delegate' then 1 when 'editor' then 2 else 3 end,
            p.full_name nulls last;
$$;
grant execute on function public.public_staff() to anon, authenticated;

-- Set the recipients of a request by its track token (accountless /office).
create or replace function public.public_set_recipients(token uuid, ids uuid[])
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tasks where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  delete from public.task_recipients where task_id = tid;
  insert into public.task_recipients (task_id, user_id)
    select tid, u from unnest(ids) as u
     where exists (select 1 from public.memberships m
                    where m.user_id = u and m.role in ('owner','delegate','editor','viewer'))
  on conflict do nothing;
  return true;
end; $$;
grant execute on function public.public_set_recipients(uuid, uuid[]) to anon, authenticated;
