-- Migration 004 — automatic reminders (server-side, no push needed).
--
-- Flags tasks/requests that need chasing so they surface under "Needs
-- attention" in the boss's view:
--   * any non-completed task past its due date, and
--   * any office request still 'pending' for more than 3 days.
--
-- This uses pg_cron (built into Supabase). Run this whole file once in the SQL
-- editor. Adjust the schedule or the '3 days' interval to taste.

create extension if not exists pg_cron;

create or replace function public.flag_stale_tasks()
returns void language sql security definer set search_path = public as $$
  update public.tasks
     set needs_attention = true
   where status <> 'completed'
     and needs_attention = false
     and (
       (due is not null and due < current_date)
       or (source = 'request' and status = 'pending' and created_at < now() - interval '3 days')
     );
$$;

-- Run every day at 07:00 UTC. (Change the cron expression as you like.)
select cron.schedule('tasktrack-daily-reminders', '0 7 * * *', $$ select public.flag_stale_tasks(); $$);

-- To remove later:  select cron.unschedule('tasktrack-daily-reminders');
