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

# set secrets (VAPID private key was generated for you — keep it secret).
# WEBHOOK_SECRET is any long random string; the DB trigger must send the same value.
supabase secrets set \
  VAPID_PUBLIC_KEY=BFJEg7wztsglrguDHyDUE_l9eO6pwvzRkNd34Mai_vkBDnzc-bX1NmMgS4PmsT6-ZUiy0cSX5HIVMNXvPsDO2MM \
  VAPID_PRIVATE_KEY=<the private key I gave you in chat> \
  VAPID_SUBJECT=mailto:you@yourdomain.com \
  WEBHOOK_SECRET=<a long random string you choose>

# deploy
supabase functions deploy send-push --no-verify-jwt
```

The function lives in `backend/functions/send-push/`. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided to functions automatically.

### b. Call it when a nudge happens

The DB trigger that fires the push is now shipped as a **migration** — you don't
paste SQL by hand. Two steps:

1. **Run the migration.** Trigger the **"Apply DB migrations"** GitHub Action
   (or apply `supabase/migrations/20250903140000_wire_push_reminders.sql`). This
   folds a best-effort push into the existing nudge trigger and creates a locked
   `public.app_settings` table to hold the webhook config (kept out of the
   browser by RLS). It's safe to run before the function is deployed — pushes are
   simply skipped until the config rows below exist.

2. **Point it at your function.** In the SQL editor, run (using the same
   `WEBHOOK_SECRET` you set on the function):

   ```sql
   insert into public.app_settings(key, value) values
     ('push_fn_url', 'https://tlapegutuiaikhbjhhkg.supabase.co/functions/v1/send-push'),
     ('push_webhook_secret', '<the same WEBHOOK_SECRET you set above>')
   on conflict (key) do update set value = excluded.value;
   ```

That's it — the next reminder will hit the boss's subscribed devices. Because the
push call is wrapped in an exception guard, a wrong URL, a down function, or a
missing key can never stop a reminder from being recorded; it just won't buzz.

> If you previously hand-installed a `notify_on_nudge` / `task_events_notify`
> trigger from an older version of this doc, the migration drops it for you so
> reminders don't fire twice.

## 4. Who gets pushed, and emailing the boss

Migration `014_notify_recipients_email` wires notifications to the right people
(it reuses the same `send-push` function + `app_settings` config as above):

- **New office request** → the boss (+ delegates) get a push, **and the Owner
  gets an email**. If the requester picked specific staff under "Who is this
  for?", those people get a push too.
- **A task is assigned to someone** → that person gets a push.
- **A reminder ("Send Reminder")** → pushes the boss/delegates **and** anyone the
  request is assigned to or was directed to.

Everything here is best-effort and exception-guarded, so a notification problem
can never block the underlying action.

### Turning on the boss's email
The email uses **Resend** (free tier: 100/day). One-time:

1. Create an account at resend.com, verify your sending domain (or use their
   test `onboarding@resend.dev` while trying it out), and copy an **API key**.
2. Add secrets to the `send-push` function:
   ```bash
   supabase secrets set RESEND_API_KEY=re_xxx EMAIL_FROM="TaskTrack <no-reply@teasooconsulting.com>"
   ```
   (Or set them under Edge Functions → your function → Secrets in the dashboard.)
3. Redeploy `send-push` (it now also sends email): `supabase functions deploy send-push --no-verify-jwt`.

If `RESEND_API_KEY` isn't set, email is simply skipped — push still works.

### Notes

- **iOS:** push only works when the app has been **added to the Home Screen**
  (installed as a PWA) on iOS 16.4+. On Android/Samsung it works installed or in
  the browser. The in-app flag (layers 1–2) works everywhere regardless.
- Recipients/assignees only get a **push** if they've enabled notifications on a
  device (Settings → Device notifications). They always see it in-app under
  **My tasks**.
