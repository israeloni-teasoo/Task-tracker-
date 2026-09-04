-- Let everyone attached to a task (requester, assignees, recipients) read and
-- post its comments/activity and see its attachments — so comments are two-way
-- on the staff dashboard, not just visible to office staff. Idempotent.

create or replace function public.is_task_participant(p_task uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tasks where id = p_task and requester_id = p_user)
      or public.is_assignee(p_task, p_user)
      or public.is_recipient(p_task, p_user);
$$;

drop policy if exists events_select on public.task_events;
create policy events_select on public.task_events for select
  using (public.is_staff() or public.is_task_participant(task_id, auth.uid()));

drop policy if exists events_insert on public.task_events;
create policy events_insert on public.task_events for insert
  with check (user_id = auth.uid() and (public.is_staff() or public.is_task_participant(task_id, auth.uid())));

drop policy if exists att_meta_select on public.task_attachments;
create policy att_meta_select on public.task_attachments for select
  using (public.is_staff() or public.is_task_participant(task_id, auth.uid()));
