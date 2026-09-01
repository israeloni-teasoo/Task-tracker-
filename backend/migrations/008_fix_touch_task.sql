-- Migration 008 — FIX: updates were failing with
-- "invalid input value for enum task_status: \"\"".
--
-- The touch_task trigger used coalesce(old.status, ''), which forces the empty
-- string '' to be cast to the task_status enum — invalid, so EVERY update to a
-- task aborted (checkbox, drag, status change all silently failed). Replace the
-- comparison with `is distinct from`, which is null-safe and casts nothing.
--
-- Run this in the Supabase SQL editor (or via `supabase db push`).

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
