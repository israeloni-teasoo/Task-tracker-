-- FIX: "infinite recursion detected in policy for relation tasks".
-- tasks_select referenced task_assignees/task_recipients, whose own SELECT
-- policies referenced tasks back -> infinite loop. Break it with SECURITY DEFINER
-- helpers (which bypass RLS on the join tables) and stop the join-table policies
-- from querying tasks. Idempotent.

create or replace function public.is_assignee(p_task uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.task_assignees where task_id = p_task and user_id = p_user);
$$;
create or replace function public.is_recipient(p_task uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.task_recipients where task_id = p_task and user_id = p_user);
$$;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select
  using (
    public.is_staff()
    or requester_id = auth.uid()
    or public.is_assignee(id, auth.uid())
    or public.is_recipient(id, auth.uid())
  );

-- Join-table SELECTs no longer reference tasks (removes the back-edge).
drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select
  using (public.is_staff() or user_id = auth.uid());

drop policy if exists task_recipients_select on public.task_recipients;
create policy task_recipients_select on public.task_recipients for select
  using (public.is_staff() or user_id = auth.uid());

-- Directory: anyone with an account can be picked as a recipient; fall back to
-- email until they've set a name (the app is authenticated-only now).
create or replace function public.public_staff()
returns table (id uuid, name text, role text)
language sql security definer set search_path = public as $$
  select p.id,
         coalesce(nullif(trim(p.full_name), ''), p.email, 'Team member') as name,
         m.role::text as role
    from public.memberships m
    join public.profiles p on p.id = m.user_id
   order by case m.role when 'owner' then 0 when 'delegate' then 1 when 'editor' then 2
                        when 'viewer' then 3 else 4 end,
            p.full_name nulls last;
$$;
grant execute on function public.public_staff() to anon, authenticated;

-- Recipients can be any account (all roles), validated against memberships.
create or replace function public.public_set_recipients(token uuid, ids uuid[])
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tasks where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  delete from public.task_recipients where task_id = tid;
  insert into public.task_recipients (task_id, user_id)
    select tid, u from unnest(ids) as u
     where exists (select 1 from public.memberships m where m.user_id = u)
  on conflict do nothing;
  return true;
end; $$;
grant execute on function public.public_set_recipients(uuid, uuid[]) to anon, authenticated;
