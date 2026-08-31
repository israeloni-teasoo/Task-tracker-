-- Migration 006 — public office request link (no account needed).
--
-- Lets anyone with the link submit a request with their name (+ optional
-- department) without signing in. The boss sees who asked. Each submission gets
-- a random track_token so the submitter's browser can check status without
-- being able to read anyone else's requests.
--
-- Run once in the Supabase SQL editor.

alter table public.tasks add column if not exists requester_name       text;
alter table public.tasks add column if not exists requester_department text;
alter table public.tasks add column if not exists track_token          uuid default gen_random_uuid();

-- Allow anonymous (not-logged-in) visitors to submit a request — and nothing
-- else. They cannot read, update or delete any rows.
drop policy if exists tasks_insert_public on public.tasks;
create policy tasks_insert_public on public.tasks for insert to anon
  with check (
    source = 'request'
    and requester_id is null
    and created_by is null
    and status = 'pending'
    and project_id is null
    and requester_name is not null
    and char_length(requester_name) between 1 and 120
    and char_length(coalesce(title, '')) between 1 and 300
  );

-- Status lookup by token, for the submitter's browser. Security definer so it
-- can read exactly one row by token without granting table read access.
create or replace function public.public_request_status(token uuid)
returns table (title text, status task_status, created_at timestamptz, needs_attention boolean)
language sql security definer set search_path = public as $$
  select title, status, created_at, needs_attention
    from public.tasks
   where track_token = token and source = 'request'
   limit 1;
$$;

grant execute on function public.public_request_status(uuid) to anon, authenticated;
