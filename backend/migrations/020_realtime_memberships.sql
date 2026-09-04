-- Broadcast membership changes so the admin's People list updates live when
-- someone accepts an invite (and stale pending invites disappear). Idempotent.
do $$
begin
  begin alter publication supabase_realtime add table public.memberships; exception when others then null; end;
end $$;
