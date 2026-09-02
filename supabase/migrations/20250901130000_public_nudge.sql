-- Public reminder ("Send Reminder" on /office) — idempotent.
-- Lets an accountless submitter flag their own request by track_token.
create or replace function public.public_nudge(token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
begin
  select id into tid from public.tasks
   where track_token = token and source = 'request' and status <> 'completed'
   limit 1;
  if tid is null then return false; end if;
  insert into public.task_events (task_id, user_id, type, message)
  values (tid, null, 'nudge', 'Reminder from requester (public link)');
  return true;
end;
$$;
grant execute on function public.public_nudge(uuid) to anon, authenticated;
