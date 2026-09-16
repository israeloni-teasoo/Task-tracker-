// Supabase Edge Function: google-calendar
// Two-way Google Calendar sync. This function is the ONLY place the OAuth
// refresh token lives — clients never see it.
//
// Deploy WITHOUT JWT verification (the OAuth callback from Google carries no
// Supabase JWT); each action authenticates itself:
//   supabase functions deploy google-calendar --no-verify-jwt
//
// Actions (JSON body { action } for POSTs; querystring for the GET callback):
//   POST start       (JWT) -> { authUrl }              begin OAuth consent
//   GET  ?action=callback  &code&state                 Google redirects here
//   POST pull        (JWT) -> { events: [...] }         refresh + list events
//   POST push        (JWT) { task }                     mirror a task -> event
//   POST disconnect  (JWT)                              revoke + forget
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID,
//   GOOGLE_CLIENT_SECRET, APP_URL (app origin to return to, e.g.
//   https://services.teasooconsulting.com).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = (Deno.env.get("APP_URL") || "").replace(/\/$/, "");
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-calendar?action=callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar.events openid email";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  // Must list every header supabase-js attaches, or the browser's preflight
  // fails with "Failed to send a request to the Edge Function".
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Identify the signed-in user from their Supabase JWT.
async function userFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// Exchange the stored refresh token for a fresh access token.
async function accessTokenFor(userId: string): Promise<{ token: string; calendarId: string } | null> {
  const { data: acct } = await admin.from("google_accounts").select("refresh_token, calendar_id").eq("user_id", userId).maybeSingle();
  if (!acct) return null;
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: acct.refresh_token, grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) { console.error("token refresh failed", tok); return null; }
  return { token: tok.access_token, calendarId: acct.calendar_id || "primary" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const qAction = url.searchParams.get("action");

  // ---- OAuth callback (browser redirect from Google; no JWT) ----
  if (req.method === "GET" && qAction === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const fail = (msg: string) => Response.redirect(`${APP_URL}/?gcal=error&reason=${encodeURIComponent(msg)}`, 302);
    if (!code || !state) return fail("missing_code");
    const { data: st } = await admin.from("google_oauth_states").select("user_id").eq("state", state).maybeSingle();
    if (!st) return fail("bad_state");
    await admin.from("google_oauth_states").delete().eq("state", state);
    // Exchange the auth code for tokens.
    const body = new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    const tok = await res.json();
    if (!res.ok || !tok.refresh_token) {
      console.error("code exchange failed", tok);
      // No refresh_token usually means the user had already granted consent;
      // prompt=consent (in `start`) forces Google to return one.
      return fail("no_refresh_token");
    }
    // Read the account email from the id_token (JWT) if present.
    let email = "";
    try { email = JSON.parse(atob(tok.id_token.split(".")[1])).email || ""; } catch { /* ignore */ }
    await admin.from("google_accounts").upsert({
      user_id: st.user_id, refresh_token: tok.refresh_token, email, calendar_id: "primary", connected_at: new Date().toISOString(),
    });
    return Response.redirect(`${APP_URL}/?gcal=connected`, 302);
  }

  // ---- Everything else is an authenticated POST ----
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const userId = await userFromRequest(req);
  if (!userId) return json({ error: "unauthorized" }, 401);
  const payload = await req.json().catch(() => ({}));
  const action = payload.action;

  try {
    if (action === "start") {
      const { data: st, error } = await admin.from("google_oauth_states").insert({ user_id: userId }).select("state").single();
      if (error) throw error;
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
        scope: SCOPE, access_type: "offline", prompt: "consent", state: st.state,
      });
      return json({ authUrl });
    }

    if (action === "disconnect") {
      const { data: acct } = await admin.from("google_accounts").select("refresh_token").eq("user_id", userId).maybeSingle();
      if (acct?.refresh_token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.refresh_token)}`, { method: "POST" }).catch(() => {});
      }
      await admin.from("google_accounts").delete().eq("user_id", userId);
      await admin.from("google_calendar_events").delete().eq("user_id", userId);
      await admin.from("task_gcal_links").delete().eq("user_id", userId);
      return json({ ok: true });
    }

    if (action === "pull") {
      const acc = await accessTokenFor(userId);
      if (!acc) return json({ error: "not_connected" }, 400);
      const now = Date.now();
      const timeMin = new Date(now - 30 * 864e5).toISOString();
      const timeMax = new Date(now + 120 * 864e5).toISOString();
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(acc.calendarId)}/events?${q}`, {
        headers: { Authorization: `Bearer ${acc.token}` },
      });
      const data = await res.json();
      if (!res.ok) { console.error("events.list failed", data); return json({ error: "list_failed" }, 502); }
      const events = (data.items || [])
        .filter((e: any) => e.status !== "cancelled" && (e.start?.dateTime || e.start?.date))
        .map((e: any) => ({
          user_id: userId, event_id: e.id, summary: e.summary || "(no title)",
          starts_at: e.start.dateTime || e.start.date,
          ends_at: e.end?.dateTime || e.end?.date || null,
          all_day: !e.start.dateTime, html_link: e.htmlLink || null, updated_at: new Date().toISOString(),
        }));
      // Refresh the cache: clear this user's rows, then insert the current window.
      await admin.from("google_calendar_events").delete().eq("user_id", userId);
      if (events.length) await admin.from("google_calendar_events").insert(events);
      return json({ events: events.map((e: any) => ({ id: e.event_id, summary: e.summary, start: e.starts_at, end: e.ends_at, allDay: e.all_day, link: e.html_link })) });
    }

    if (action === "push") {
      const t = payload.task;
      if (!t || !t.id) return json({ error: "no_task" }, 400);
      const acc = await accessTokenFor(userId);
      if (!acc) return json({ error: "not_connected" }, 400);
      const { data: link } = await admin.from("task_gcal_links").select("google_event_id").eq("task_id", t.id).maybeSingle();
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(acc.calendarId)}/events`;

      // No due date, or completed/deleted -> remove any mirrored event.
      if (t.deleted || t.status === "completed" || !t.due) {
        if (link) {
          await fetch(`${base}/${link.google_event_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${acc.token}` } }).catch(() => {});
          await admin.from("task_gcal_links").delete().eq("task_id", t.id);
        }
        return json({ ok: true, removed: !!link });
      }

      const start = new Date(t.due);
      const timed = !(start.getUTCHours() === 0 && start.getUTCMinutes() === 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1h default
      const event = {
        summary: `📋 ${t.title}`,
        description: (t.notes || "") + "\n\n— synced from TaskTrack",
        start: timed ? { dateTime: start.toISOString() } : { date: t.due.slice(0, 10) },
        end: timed ? { dateTime: end.toISOString() } : { date: t.due.slice(0, 10) },
      };
      let eventId = link?.google_event_id;
      const res = await fetch(eventId ? `${base}/${eventId}` : base, {
        method: eventId ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${acc.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      const data = await res.json();
      if (!res.ok) { console.error("event write failed", data); return json({ error: "write_failed" }, 502); }
      eventId = data.id;
      await admin.from("task_gcal_links").upsert({ task_id: t.id, user_id: userId, google_event_id: eventId, calendar_id: acc.calendarId, updated_at: new Date().toISOString() });
      return json({ ok: true, eventId });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("google-calendar error", e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
