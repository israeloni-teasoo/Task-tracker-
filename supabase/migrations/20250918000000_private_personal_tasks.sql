-- Privacy: a personal task (created by someone, with NO assignees and not a
-- request) should be visible only to its creator (and that person's delegates),
-- NOT to every other admin/staff via "All tasks". Shared work — anything with an
-- assignee, or an office request — stays office-wide for staff. Idempotent.

create or replace function public.has_assignees(p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.task_assignees where task_id = p_task);
$$;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select
  using (
    created_by = auth.uid()                         -- my own tasks (even private)
    or requester_id = auth.uid()                    -- requests I raised
    or public.is_assignee(id, auth.uid())           -- assigned to me
    or public.is_recipient(id, auth.uid())          -- directed to me
    or public.is_delegate_for_task(id)              -- I manage this person's desk
    or (public.is_staff() and (source = 'request' or public.has_assignees(id)))
  );
