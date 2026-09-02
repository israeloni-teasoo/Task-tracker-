-- Fix: updates were failing with "invalid input value for enum task_status: ''".
-- touch_task cast '' to the enum via coalesce(old.status, ''); use a null-safe
-- comparison instead. Idempotent (create or replace).
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
