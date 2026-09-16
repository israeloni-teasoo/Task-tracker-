-- Fix: a delegate could read their principal's tasks (migration 025) but NOT the
-- task_assignees / task_recipients rows that mark those tasks as the principal's,
-- so the "manage <principal>'s desk" view came up empty. Also let a delegate read
-- their principal's cached Google Calendar events. Idempotent.

drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select
  using (public.is_staff() or user_id = auth.uid() or public.is_delegate_for_task(task_id));

drop policy if exists task_recipients_select on public.task_recipients;
create policy task_recipients_select on public.task_recipients for select
  using (public.is_staff() or user_id = auth.uid() or public.is_delegate_for_task(task_id));

-- A delegate sees their principal's Google events (read-only overlay).
drop policy if exists gcal_events_read on public.google_calendar_events;
create policy gcal_events_read on public.google_calendar_events for select
  using (
    user_id = auth.uid() or public.is_owner()
    or public.app_current_role() = 'delegate'
    or public.is_delegate_of(user_id)
  );
