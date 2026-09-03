-- Push to the right people + email the boss on new requests.
-- All best-effort: any failure is swallowed so it can't block the write.
-- Requires the send-push function config in app_settings (see docs/NOTIFICATIONS.md)
-- and, for email, RESEND_API_KEY set on the send-push function.

-- Fire a push to an explicit set of users (NULL user_ids => send-push defaults
-- to owner + delegate).
create or replace function public._fire_push(p_task_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare fn_url text; secret text;
begin
  begin
    select value into fn_url from public.app_settings where key = 'push_fn_url';
    select value into secret from public.app_settings where key = 'push_webhook_secret';
    if fn_url is not null and secret is not null then
      perform net.http_post(
        url := fn_url,
        body := jsonb_build_object('task_id', p_task_id, 'user_ids', to_jsonb(p_user_ids)),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret)
      );
    end if;
  exception when others then null; end;
end; $$;

-- Ask send-push to email the current Owner.
create or replace function public._fire_email_owner(p_subject text, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare fn_url text; secret text; owner_email text;
begin
  begin
    select value into fn_url from public.app_settings where key = 'push_fn_url';
    select value into secret from public.app_settings where key = 'push_webhook_secret';
    select p.email into owner_email
      from public.memberships m join public.profiles p on p.id = m.user_id
     where m.role = 'owner' limit 1;
    if fn_url is not null and secret is not null and owner_email is not null then
      perform net.http_post(
        url := fn_url,
        body := jsonb_build_object('email',
                 jsonb_build_object('to', owner_email, 'subject', p_subject, 'text', p_text)),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret)
      );
    end if;
  exception when others then null; end;
end; $$;

-- New office request → push owner/delegate now (recipients get theirs from the
-- recipients trigger, since they're set just after insert) + email the boss.
create or replace function public.on_new_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'request' then
    perform public._fire_push(new.id, null);   -- null => owner + delegate
    perform public._fire_email_owner(
      'New office request: ' || coalesce(new.title, '(untitled)'),
      coalesce(new.requester_name, 'Someone')
        || coalesce(' (' || new.requester_department || ')', '')
        || ' submitted a request:' || chr(10) || chr(10)
        || coalesce(new.title, '') || chr(10)
        || coalesce(new.notes, '') || chr(10) || chr(10)
        || 'Open TaskTrack to see it.');
  end if;
  return new;
end; $$;
drop trigger if exists tasks_new_request on public.tasks;
create trigger tasks_new_request after insert on public.tasks
  for each row execute function public.on_new_request();

-- Someone is added as a recipient of a request → push them.
create or replace function public.on_recipient_added()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._fire_push(new.task_id, array[new.user_id]);
  return new;
end; $$;
drop trigger if exists task_recipients_added on public.task_recipients;
create trigger task_recipients_added after insert on public.task_recipients
  for each row execute function public.on_recipient_added();

-- Someone is assigned a task → push them.
create or replace function public.on_assignee_added()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._fire_push(new.task_id, array[new.user_id]);
  return new;
end; $$;
drop trigger if exists task_assignees_added on public.task_assignees;
create trigger task_assignees_added after insert on public.task_assignees
  for each row execute function public.on_assignee_added();

-- Nudge → flag + push owner/delegate ∪ recipients ∪ assignees (one call).
create or replace function public.flag_on_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
declare targets uuid[];
begin
  if new.type = 'nudge' then
    update public.tasks set needs_attention = true where id = new.task_id;
    begin
      select array_agg(distinct uid) into targets from (
        select user_id uid from public.memberships where role in ('owner', 'delegate')
        union select user_id from public.task_recipients where task_id = new.task_id
        union select user_id from public.task_assignees where task_id = new.task_id
      ) s;
      perform public._fire_push(new.task_id, targets);
    exception when others then null; end;
  end if;
  return new;
end; $$;
