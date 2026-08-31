-- Migration 007 — let public (no-account) submitters nudge their own request.
--
-- The office request page has no login, so it can't insert task_events under
-- the normal RLS. This security-definer function inserts a nudge event for the
-- request identified by its track_token; the existing flag_on_nudge trigger
-- then raises the "needs attention" flag on the boss's board.
--
-- Run once in the Supabase SQL editor.

create or replace function public.public_nudge(token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
begin
  select id into tid from public.tasks
   where track_token = token and source = 'request' and status <> 'completed'
   limit 1;
  if tid is null then
    return false;
  end if;
  insert into public.task_events (task_id, user_id, type, message)
  values (tid, null, 'nudge', 'Nudge from requester (public link)');
  return true;
end;
$$;

grant execute on function public.public_nudge(uuid) to anon, authenticated;
