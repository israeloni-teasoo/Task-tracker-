-- Migration 005 — pre-assign roles by email (invites) + owner bootstrap.
--
-- Run this once in the Supabase SQL editor. It supersedes migration 001: the
-- new sign-up trigger still makes the very first user the Owner (that's you,
-- testing), but now also honours a pre-assigned role for an email, so you can
-- add the boss's email as Owner BEFORE she signs in. Multiple Owners are
-- allowed, so promoting her never removes your own access.

-- Pre-assigned roles, keyed by email (lower-cased).
create table if not exists public.role_invites (
  email      text primary key,
  role       app_role not null default 'requester',
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.role_invites enable row level security;

drop policy if exists role_invites_owner on public.role_invites;
create policy role_invites_owner on public.role_invites for all
  using (public.is_owner()) with check (public.is_owner());

-- Sign-up: first user => owner; else if an invite exists for the email, use it
-- (and consume it); otherwise default to requester.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned app_role := 'requester';
  invited  app_role;
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  if not exists (select 1 from public.memberships where role = 'owner') then
    assigned := 'owner';                                   -- first user (you)
  else
    select role into invited from public.role_invites
      where email = lower(new.email);
    if invited is not null then
      assigned := invited;                                 -- pre-assigned role
      delete from public.role_invites where email = lower(new.email);
    end if;
  end if;

  insert into public.memberships (user_id, role)
  values (new.id, assigned) on conflict (user_id) do nothing;

  return new;
end;
$$;
