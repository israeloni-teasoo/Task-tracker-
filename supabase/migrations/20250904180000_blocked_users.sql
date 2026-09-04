-- Removing a person revokes their access: their membership is deleted (so they
-- vanish from every staff list) AND they're recorded here so they can't slip
-- back in as a de-facto requester. app_current_role() returns null for a blocked
-- user, and the app signs them out on entry. Idempotent.
create table if not exists public.blocked_users (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  blocked_by uuid references public.profiles(id) on delete set null,
  blocked_at timestamptz not null default now()
);
alter table public.blocked_users enable row level security;

-- A user may see their own block row (to self-check); Admin/Managing Partner manage.
drop policy if exists blocked_self_select on public.blocked_users;
create policy blocked_self_select on public.blocked_users for select
  using (user_id = auth.uid() or public.is_owner() or public.app_current_role() = 'delegate');
drop policy if exists blocked_manage on public.blocked_users;
create policy blocked_manage on public.blocked_users for all
  using (public.is_owner() or public.app_current_role() = 'delegate')
  with check (public.is_owner() or public.app_current_role() = 'delegate');

-- A blocked user has no effective role.
create or replace function public.app_current_role()
returns app_role language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.blocked_users where user_id = auth.uid()) then null
    else (select role from public.memberships where user_id = auth.uid())
  end;
$$;
