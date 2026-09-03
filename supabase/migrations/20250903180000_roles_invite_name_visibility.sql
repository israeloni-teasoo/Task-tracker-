-- Invite-with-name, requester name in the boss's email, and letting assignees /
-- recipients see the tasks that concern them. Idempotent.

-- ── Invites can carry a name (e.g. the boss = "Managing Partner") ────────────
alter table public.role_invites add column if not exists full_name text;

-- Apply the invited name + role on sign-up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned app_role := 'requester';
  invited  app_role;
  inv_name text;
begin
  select role, full_name into invited, inv_name from public.role_invites where email = lower(new.email);

  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', inv_name),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  if not exists (select 1 from public.memberships where role = 'owner') then
    assigned := 'owner';
  elsif invited is not null then
    assigned := invited;
  end if;
  delete from public.role_invites where email = lower(new.email);

  insert into public.memberships (user_id, role)
  values (new.id, assigned) on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ── Assignees / recipients can see the tasks that concern them ───────────────
-- (so a requester or viewer assigned a task actually sees it in their dashboard)
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select
  using (
    public.is_staff()
    or requester_id = auth.uid()
    or exists (select 1 from public.task_assignees a where a.task_id = id and a.user_id = auth.uid())
    or exists (select 1 from public.task_recipients r where r.task_id = id and r.user_id = auth.uid())
  );

-- ── Boss email: put the requester's name up front so it's easy to filter ────
create or replace function public.on_new_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if new.source = 'request' then
    who := coalesce(
      nullif(trim(new.requester_name), ''),
      (select nullif(trim(full_name), '') from public.profiles where id = new.requester_id),
      (select email from public.profiles where id = new.requester_id),
      'A team member');
    perform public._fire_push(new.id, null);
    perform public._fire_email_owner(
      'New request from ' || who || ': ' || coalesce(new.title, '(untitled)'),
      who || coalesce(' (' || new.requester_department || ')', '')
        || ' submitted a request:' || chr(10) || chr(10)
        || coalesce(new.title, '') || chr(10)
        || coalesce(new.notes, '') || chr(10) || chr(10)
        || 'Requested by: ' || who || chr(10)
        || 'Open TaskTrack to see it.');
  end if;
  return new;
end; $$;
