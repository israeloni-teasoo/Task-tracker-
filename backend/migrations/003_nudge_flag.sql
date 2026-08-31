-- Migration 003 — nudges raise the "needs attention" flag.
--
-- Run in the Supabase SQL editor if you applied schema.sql before it included
-- this. When a requester (or anyone) inserts a nudge event on a task, the task
-- is flagged so it stands out in the boss's view. Safe to run once.

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
