-- Server-side rate limit for the public /office "Send Reminder" button.
-- The client throttle (localStorage) is bypassable, so enforce a real cooldown
-- in the database: at most one reminder per request every 30 minutes, and none
-- once the request is completed. Returns a status string so the page can show a
-- precise message. Idempotent.
--
-- The return type changes (boolean -> text), so drop first.
drop function if exists public.public_nudge(uuid);

create or replace function public.public_nudge(token uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
  st  text;
  last_at timestamptz;
begin
  select id, status::text into tid, st from public.tasks
   where track_token = token and source = 'request'
   limit 1;
  if tid is null then return 'notfound'; end if;
  if st = 'completed' then return 'completed'; end if;

  select max(created_at) into last_at
    from public.task_events
   where task_id = tid and type = 'nudge';
  if last_at is not null and last_at > now() - interval '30 minutes' then
    return 'cooldown';
  end if;

  insert into public.task_events (task_id, user_id, type, message)
  values (tid, null, 'nudge', 'Reminder from requester (public link)');
  return 'ok';
end;
$$;

grant execute on function public.public_nudge(uuid) to anon, authenticated;
