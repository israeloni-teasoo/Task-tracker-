-- Platform-only metadata attached to a Google Calendar event (project, priority,
-- status, assignees, notes). These enrich the event inside TaskTrack; they are
-- NOT sent to Google. Keyed by the calendar owner + Google event id. Idempotent.

create table if not exists public.gcal_event_meta (
  user_id    uuid not null references public.profiles(id) on delete cascade,  -- calendar owner
  event_id   text not null,
  project_id uuid references public.projects(id) on delete set null,
  priority   text,
  status     text,
  assignees  uuid[] not null default '{}',
  notes      text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table public.gcal_event_meta enable row level security;

-- Same audience as the events themselves: the owner, an admin, a role-delegate,
-- or a personal delegate of the owner — all may read and write the metadata.
drop policy if exists gcal_meta_rw on public.gcal_event_meta;
create policy gcal_meta_rw on public.gcal_event_meta for all
  using (
    user_id = auth.uid() or public.is_owner()
    or public.app_current_role() = 'delegate' or public.is_delegate_of(user_id)
  )
  with check (
    user_id = auth.uid() or public.is_owner()
    or public.app_current_role() = 'delegate' or public.is_delegate_of(user_id)
  );
