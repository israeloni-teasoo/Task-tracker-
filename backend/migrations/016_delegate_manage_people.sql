-- Let the Managing Partner (delegate) manage people too — invite, change roles,
-- and remove — but never touch Admins (owner) or grant the Admin role. The Admin
-- (owner) keeps full control. Idempotent.

drop policy if exists memberships_write on public.memberships;
create policy memberships_write on public.memberships for all
  using (
    public.is_owner()
    or (public.app_current_role() = 'delegate' and role <> 'owner')
  )
  with check (
    public.is_owner()
    or (public.app_current_role() = 'delegate' and role <> 'owner')
  );

drop policy if exists role_invites_owner on public.role_invites;
drop policy if exists role_invites_manage on public.role_invites;
create policy role_invites_manage on public.role_invites for all
  using (
    public.is_owner()
    or public.app_current_role() = 'delegate'
  )
  with check (
    public.is_owner()
    or (public.app_current_role() = 'delegate' and role <> 'owner')
  );
