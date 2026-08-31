-- Migration 002 — enable realtime (live cross-device sync).
--
-- Run this in the Supabase SQL editor if you ran schema.sql BEFORE it included
-- these lines. It adds the tables to Supabase's realtime publication so the app
-- gets live INSERT/UPDATE/DELETE events. Row-Level Security still controls what
-- each client is allowed to receive. Safe to run once.
--
-- If a table is already in the publication, that ADD errors harmlessly — you can
-- ignore "relation is already member of publication" for any line.

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.task_events;
