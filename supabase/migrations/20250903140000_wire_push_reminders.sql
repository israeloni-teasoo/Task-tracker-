-- Wire reminders to real Web Push on the boss's devices.
--
-- Until now a "nudge" only set needs_attention; the send-push Edge Function was
-- never called, so the boss only saw reminders while the app was open. This
-- makes the nudge trigger also fire a push — best-effort, so a delivery problem
-- (missing config, function down, pg_net absent) can NEVER roll back the nudge.
--
-- Config lives in public.app_settings (not in this file, so no secrets are
-- committed). After running this, insert the two rows — see docs/NOTIFICATIONS.md:
--   insert into public.app_settings(key,value) values
--     ('push_fn_url','https://<PROJECT_REF>.supabase.co/functions/v1/send-push'),
--     ('push_webhook_secret','<same secret set as WEBHOOK_SECRET on the function>')
--   on conflict (key) do update set value = excluded.value;
--
-- Idempotent.

create extension if not exists pg_net;

-- Locked-down settings table: RLS on with NO policies means the app's anon /
-- authenticated clients can never read it; only security-definer functions and
-- the service role can. This keeps the webhook secret out of the browser.
create table if not exists public.app_settings (
  key   text primary key,
  value text
);
alter table public.app_settings enable row level security;

create or replace function public.flag_on_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fn_url text;
  secret text;
begin
  if new.type = 'nudge' then
    update public.tasks set needs_attention = true where id = new.task_id;

    -- Best-effort device push. Wrapped so any failure is swallowed and the
    -- nudge insert always commits.
    begin
      select value into fn_url from public.app_settings where key = 'push_fn_url';
      select value into secret from public.app_settings where key = 'push_webhook_secret';
      if fn_url is not null and secret is not null then
        perform net.http_post(
          url := fn_url,
          body := jsonb_build_object('task_id', new.task_id),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret)
        );
      end if;
    exception when others then
      null;   -- never block a reminder because push failed
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists task_events_nudge on public.task_events;
create trigger task_events_nudge after insert on public.task_events
  for each row execute function public.flag_on_nudge();

-- Remove any earlier hand-installed push trigger so nudges don't double-fire.
drop trigger if exists task_events_notify on public.task_events;
drop function if exists public.notify_on_nudge();
