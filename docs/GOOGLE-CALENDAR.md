# Google Calendar two-way sync

TaskTrack can show a user's Google Calendar events inside the **Calendar view**,
and push TaskTrack tasks (those with a due date) back into Google as events.
This is opt-in per user: each person connects their **own** Google account from
**Settings → Google Calendar → Connect**.

The OAuth refresh token lives **only** inside the `google-calendar` Edge
Function (server-side). It is never sent to the browser and cannot be read by
any client — the database table that holds it has no client policies.

---

## One-time setup (Admin)

You must create a Google Cloud OAuth client and set four secrets on the Edge
Function. Nothing syncs until this is done.

### 1. Create a Google Cloud project + OAuth client

1. Go to <https://console.cloud.google.com> → create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name, support email, developer email — fill in.
   - **Scopes:** add `.../auth/calendar.events` (see, edit, create events).
   - **Test users:** while the app is in *Testing* mode, add the exact Google
     addresses that will connect (the Managing Partner, the PA, you). Only test
     users can connect until you publish. For a handful of internal users,
     staying in **Testing** is fine and avoids Google's verification review.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URI** — this exact value:
     ```
     https://tlapegutuiaikhbjhhkg.supabase.co/functions/v1/google-calendar?action=callback
     ```
   - Create, then copy the **Client ID** and **Client secret**.

### 2. Deploy the Edge Function

The callback comes from Google with **no** Supabase JWT, so deploy with JWT
verification off (the function authenticates each action itself):

```bash
supabase functions deploy google-calendar --no-verify-jwt
```

### 3. Set the function secrets

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID="<your client id>" \
  GOOGLE_CLIENT_SECRET="<your client secret>" \
  APP_URL="https://services.teasooconsulting.com"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions
automatically. `APP_URL` must be the exact origin the app is served from — it is
where Google returns the user after they approve.

### 4. Apply the database migration

Run the **Apply DB migrations** GitHub Action (or apply
`supabase/migrations/20250915000000_google_calendar.sql`). It creates the
`google_accounts`, `google_oauth_states`, `google_calendar_events`,
`task_gcal_links` tables and the `google_connection()` status helper.

---

## How it works

- **Connect:** Settings → *Connect* calls the function's `start` action, which
  returns a Google consent URL; the browser goes there. After approval Google
  redirects to the function's `callback`, which exchanges the code for a refresh
  token, stores it, and returns you to the app (`?gcal=connected`).
- **Read (pull):** on load and after connecting, the app calls `pull`. The
  function refreshes an access token, lists events in a window (−30 to +120
  days), caches them, and the Calendar view overlays them as blue chips
  (click to open in Google).
- **Write (push):** creating or updating a task **with a due date** mirrors it
  to the connected user's primary calendar (`📋 <title>`). Completing, deleting,
  or clearing the due date removes the mirrored event. The task ↔ event mapping
  lives in `task_gcal_links`.
- **Visibility:** the Managing Partner (a delegate) and her PA / the Admin can
  all see her pulled Google events, matching how they already share office tasks
  (RLS policy `gcal_events_read`).
- **Disconnect:** Settings → *Disconnect* revokes the token at Google and
  deletes the stored token, cached events, and task links for that user.

---

## Troubleshooting

- **"Google connection failed (no_refresh_token)"** — Google only returns a
  refresh token on first consent. The function forces it with `prompt=consent`;
  if you still see this, remove TaskTrack at
  <https://myaccount.google.com/permissions> and connect again.
- **"Google connection failed (bad_state)"** — the consent took too long or the
  state row was cleared; just click Connect again.
- **Nothing happens on Connect / "function not deployed"** — confirm
  `supabase functions deploy google-calendar --no-verify-jwt` ran and the three
  secrets are set.
- **`redirect_uri_mismatch` from Google** — the Authorized redirect URI in the
  Cloud console must match the one in step 1 **exactly**, including
  `?action=callback`.
- **Access blocked / "app not verified"** — add the person as a **Test user** on
  the OAuth consent screen (Testing mode), or publish the app.
