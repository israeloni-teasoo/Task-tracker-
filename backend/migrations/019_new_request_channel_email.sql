-- New requests now notify owner+delegate through send-push, which handles BOTH
-- push and email per each user's channel preferences. Drop the separate always-on
-- owner email so the boss's email toggle is respected and she isn't emailed twice.
-- Idempotent.
create or replace function public.on_new_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'request' then
    perform public._fire_push(new.id, null);   -- null => owner + delegate; send-push does push + email per prefs
  end if;
  return new;
end; $$;
