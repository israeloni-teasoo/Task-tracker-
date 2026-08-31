# Notifications & reminders

TaskTrack surfaces things the boss needs to act on in three layers, from
zero-setup to optional.

## 1. In-app "Needs attention" flag — works now, nothing to set up

- When a requester **nudges** a request, or a task goes **overdue**, the task is
  flagged. Flagged tasks get an orange highlight and a **⚠ Needs attention**
  badge, and there's a **Needs attention** filter in the sidebar with a live
  count.
- This is driven entirely by the database (the nudge trigger + the reminder
  job), so it shows up on every device the boss opens.

## 2. Automatic reminders — one SQL file

`backend/migrations/004_reminders_cron.sql` schedules a daily job (via
`pg_cron`, built into Supabase) that flags:

- any non-completed task past its due date, and
- any office request left **pending** for more than 3 days.

Run that file once in the SQL editor. Adjust the schedule/interval inside it to
taste.

## 3. Device push notifications (optional) — needs a small deploy

This makes her phone actually buzz. It needs a server piece, because a browser
can't send a push to itself. The app already does the browser half: the
🔔 **Enable notifications** button subscribes the device and stores it in
`push_subscriptions`. To send the pushes:

### a. Deploy the Edge Function

```bash
# one-time
npm i -g supabase
supabase login
supabase link --project-ref tlapegutuiaikhbjhhkg

# set secrets (VAPID private key was generated for you — keep it secret)
supabase secrets set \
  VAPID_PUBLIC_KEY=BFJEg7wztsglrguDHyDUE_l9eO6pwvzRkNd34Mai_vkBDnzc-bX1NmMgS4PmsT6-ZUiy0cSX5HIVMNXvPsDO2MM \
  VAPID_PRIVATE_KEY=<the private key I gave you in chat> \
  VAPID_SUBJECT=mailto:you@yourdomain.com

# deploy
supabase functions deploy send-push --no-verify-jwt
```

The function lives in `backend/functions/send-push/`. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided to functions automatically.

### b. Call it when a nudge happens

Run this in the SQL editor so each nudge pings the boss's devices:

```sql
create extension if not exists pg_net;

create or replace function public.notify_on_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'nudge' then
    perform net.http_post(
      url := 'https://tlapegutuiaikhbjhhkg.functions.supabase.co/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('task_id', new.task_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists task_events_notify on public.task_events;
create trigger task_events_notify after insert on public.task_events
  for each row execute function public.notify_on_nudge();
```

### Notes

- **iOS:** push only works when the app has been **added to the Home Screen**
  (installed as a PWA) on iOS 16.4+. On Android/Samsung it works installed or in
  the browser. The in-app flag (layers 1–2) works everywhere regardless.
- To also push the daily reminders, call the same function from
  `flag_stale_tasks()` for each newly-flagged task, or add a second scheduled
  job that posts a summary. The nudge path above is the common case.
