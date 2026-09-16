-- Personal delegation: any user may name delegate(s) who can manage ONLY that
-- user's (the principal's) tasks — nothing else. This is least-privilege and
-- independent of the global `delegate` role (which the Managing Partner holds
-- for full office access). A user can have multiple delegates, and be a delegate
-- for multiple principals. Idempotent.

create table if not exists public.delegations (
  principal_id uuid not null references public.profiles(id) on delete cascade,
  delegate_id  uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (principal_id, delegate_id),
  check (principal_id <> delegate_id)
);
alter table public.delegations enable row level security;

-- You see delegations where you're the principal or the delegate; owner sees all.
drop policy if exists delegations_select on public.delegations;
create policy delegations_select on public.delegations for select
  using (principal_id = auth.uid() or delegate_id = auth.uid() or public.is_owner());
-- You manage only your own delegates (as principal); owner may manage any.
drop policy if exists delegations_manage on public.delegations;
create policy delegations_manage on public.delegations for all
  using (principal_id = auth.uid() or public.is_owner())
  with check (principal_id = auth.uid() or public.is_owner());

-- ---------- Definer helpers (bypass RLS to avoid recursion) ----------
-- Am I a delegate of this specific person?
create or replace function public.is_delegate_of(p_principal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.delegations
    where delegate_id = auth.uid() and principal_id = p_principal
  );
$$;

-- Am I a delegate of anyone attached to this task (creator/requester/assignee/
-- recipient)? Governs which tasks a delegate may see and modify.
create or replace function public.is_delegate_for_task(p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.delegations d
    where d.delegate_id = auth.uid()
      and (
        exists (select 1 from public.tasks t
                where t.id = p_task
                  and (t.created_by = d.principal_id or t.requester_id = d.principal_id))
        or public.is_assignee(p_task, d.principal_id)
        or public.is_recipient(p_task, d.principal_id)
      )
  );
$$;

-- ---------- Task access for delegates (additive; OR-ed with existing policies) ----------
drop policy if exists tasks_select_delegate on public.tasks;
create policy tasks_select_delegate on public.tasks for select
  using (public.is_delegate_for_task(id));

drop policy if exists tasks_update_delegate on public.tasks;
create policy tasks_update_delegate on public.tasks for update
  using (public.is_delegate_for_task(id)) with check (public.is_delegate_for_task(id));

drop policy if exists tasks_delete_delegate on public.tasks;
create policy tasks_delete_delegate on public.tasks for delete
  using (public.is_delegate_for_task(id));

-- A delegate may create internal tasks (they author them, then assign a principal).
drop policy if exists tasks_insert_delegate on public.tasks;
create policy tasks_insert_delegate on public.tasks for insert
  with check (
    created_by = auth.uid() and source = 'internal'
    and exists (select 1 from public.delegations where delegate_id = auth.uid())
  );

-- Let a delegate manage assignees: add their principal to a task, or edit
-- assignees on tasks that already belong to their principal.
drop policy if exists task_assignees_write on public.task_assignees;
create policy task_assignees_write on public.task_assignees for all
  using (public.can_edit() or public.is_delegate_for_task(task_id))
  with check (public.can_edit() or public.is_delegate_of(user_id) or public.is_delegate_for_task(task_id));
