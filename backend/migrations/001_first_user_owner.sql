-- Migration 001 — auto-assign the first user as Owner.
--
-- Run this in the Supabase SQL editor if you already ran schema.sql BEFORE it
-- included this behaviour. It only replaces the sign-up trigger function; it
-- does not touch any data. Safe to run more than once.
--
-- IMPORTANT: run this BEFORE the boss signs in for the first time, so her
-- account is the one promoted to Owner. (If someone has already signed in,
-- promote the boss manually with the statement at the bottom.)

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned app_role := 'requester';
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  if not exists (select 1 from public.memberships where role = 'owner') then
    assigned := 'owner';
  end if;

  insert into public.memberships (user_id, role)
  values (new.id, assigned) on conflict (user_id) do nothing;

  return new;
end;
$$;

-- If someone already signed in before this migration, promote the boss by email:
--   update public.memberships set role = 'owner'
--   where user_id = (select id from public.profiles where email = 'boss@example.com');
