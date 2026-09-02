-- Harden the anonymous public-request insert policy: cap the size of every
-- attacker-controlled field so the open /office endpoint can't be used to push
-- huge payloads into the database. Idempotent (drop + recreate).

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
    and char_length(coalesce(requester_department, '')) <= 120
    and char_length(coalesce(title, '')) between 1 and 300
    and char_length(coalesce(notes, '')) <= 2000
  );
