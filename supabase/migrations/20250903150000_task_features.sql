-- Feature batch: task assignment, due time, comment threads, attachments.
-- All statements are idempotent.

-- ── 1. Assign tasks to a staff member ───────────────────────────────────────
alter table public.tasks
  add column if not exists assignee_id uuid references public.profiles(id) on delete set null;
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);

-- ── 2. Due time (widen `due` from date to timestamptz) ──────────────────────
-- Existing date values become midnight of that day. Safe to run repeatedly.
do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'tasks' and column_name = 'due') = 'date' then
    alter table public.tasks alter column due type timestamptz using (due::timestamptz);
  end if;
end $$;

-- ── 3. Attachments (files on a task / office request) ───────────────────────
-- Metadata lives here; the file bytes live in the private Storage bucket below.
create table if not exists public.task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  path         text not null,               -- storage object path within the bucket
  filename     text not null,
  content_type text,
  size         bigint,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  track_token  uuid,                        -- set on accountless /office uploads
  created_at   timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on public.task_attachments(task_id);
alter table public.task_attachments enable row level security;

drop policy if exists att_meta_select on public.task_attachments;
create policy att_meta_select on public.task_attachments for select
  using (
    public.is_staff()
    or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = auth.uid())
  );

drop policy if exists att_meta_insert_staff on public.task_attachments;
create policy att_meta_insert_staff on public.task_attachments for insert
  with check (public.is_staff() and uploaded_by = auth.uid());

-- Private Storage bucket for the file bytes + its access policies. Guarded: on
-- some projects the migration role can't own storage.objects, so a failure here
-- must NOT abort the rest of the migration — set them in the dashboard instead.
do $$
begin
  begin
    insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false)
      on conflict (id) do nothing;
    -- Anyone may upload (the office page is accountless); only signed-in staff
    -- may read (they download via short-lived signed URLs).
    execute 'drop policy if exists att_obj_insert on storage.objects';
    execute 'create policy att_obj_insert on storage.objects for insert to anon, authenticated with check (bucket_id = ''attachments'')';
    execute 'drop policy if exists att_obj_select on storage.objects';
    execute 'create policy att_obj_select on storage.objects for select to authenticated using (bucket_id = ''attachments'')';
  exception when others then
    raise notice 'Storage bucket/policies not set automatically (%). Create bucket "attachments" (private) and its policies in the Supabase dashboard.', sqlerrm;
  end;
end $$;

-- Accountless /office attachment: record metadata against a request by its token.
create or replace function public.public_add_attachment(
  token uuid, p text, fname text, ctype text, fsize bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tasks
   where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  insert into public.task_attachments (task_id, path, filename, content_type, size, track_token)
  values (tid, p, fname, ctype, fsize, token);
  return true;
end; $$;
grant execute on function public.public_add_attachment(uuid, text, text, text, bigint) to anon, authenticated;

-- ── 4. Comment / activity thread over the public link ───────────────────────
-- Staff read/write task_events directly (existing RLS). These RPCs let an
-- accountless /office submitter read the thread and post a comment by token.
create or replace function public.public_request_events(token uuid)
returns table (type text, message text, created_at timestamptz, author text)
language sql security definer set search_path = public as $$
  select e.type::text, e.message, e.created_at,
         coalesce(p.full_name, p.email,
                  case when e.user_id is null then 'Requester' else 'Staff' end) as author
    from public.task_events e
    join public.tasks t on t.id = e.task_id
    left join public.profiles p on p.id = e.user_id
   where t.track_token = token and t.source = 'request'
     and e.type in ('comment', 'nudge', 'status_change')
   order by e.created_at asc;
$$;
grant execute on function public.public_request_events(uuid) to anon, authenticated;

create or replace function public.public_add_comment(token uuid, body text)
returns boolean language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if body is null or length(trim(body)) = 0 or length(body) > 2000 then return false; end if;
  select id into tid from public.tasks
   where track_token = token and source = 'request' limit 1;
  if tid is null then return false; end if;
  insert into public.task_events (task_id, user_id, type, message)
  values (tid, null, 'comment', trim(body));
  return true;
end; $$;
grant execute on function public.public_add_comment(uuid, text) to anon, authenticated;
