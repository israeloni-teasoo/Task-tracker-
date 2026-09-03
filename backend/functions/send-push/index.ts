// Supabase Edge Function: send-push
// Sends Web Push notifications and (optionally) emails the boss. Called only by
// DB triggers that know the shared WEBHOOK_SECRET.
//
// Request body (any combination):
//   { task_id }                    -> push about a task to owners + delegates
//   { task_id, user_ids: [...] }   -> push about a task to those specific users
//   { title, body, user_ids }      -> push a custom message to those users
//   { email: { to, subject, text } } -> send an email (via Resend)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
//   VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEBHOOK_SECRET.
//   For email: RESEND_API_KEY and (optional) EMAIL_FROM.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY")!;
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY")!;
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "TaskTrack <onboarding@resend.dev>";

webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
const admin = createClient(supabaseUrl, serviceKey);

Deno.serve(async (req) => {
  try {
    // Only the DB trigger (which knows the shared secret) may call this.
    if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const { task_id, title, body, user_ids, email } = await req.json().catch(() => ({}));

    let pushed = 0;
    const wantPush = (Array.isArray(user_ids) && user_ids.length > 0) || !!task_id;
    if (wantPush) pushed = await doPush({ task_id, title, body, user_ids });

    let emailed = false;
    if (email && email.to) emailed = await sendEmail(email.to, email.subject, email.text);

    return json({ pushed, emailed });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function doPush(
  { task_id, title, body, user_ids }:
  { task_id?: string; title?: string; body?: string; user_ids?: string[] },
): Promise<number> {
  // Who receives it: the explicit list, else all owners + delegates.
  let ids: string[] = [];
  if (Array.isArray(user_ids) && user_ids.length) {
    ids = user_ids.filter(Boolean);
  } else {
    const { data: staff } = await admin.from("memberships").select("user_id").in("role", ["owner", "delegate"]);
    ids = (staff || []).map((s) => s.user_id);
  }
  ids = [...new Set(ids)];
  if (!ids.length) return 0;

  let msgTitle = title || "TaskTrack";
  let msgBody = body || "Something needs your attention.";
  if (task_id && !body) {
    const { data: t } = await admin.from("tasks").select("title, source").eq("id", task_id).maybeSingle();
    if (t) msgBody = t.source === "request" ? `New request: "${t.title}"` : `"${t.title}" needs your attention.`;
  }

  const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", ids);
  const payload = JSON.stringify({ title: msgTitle, body: msgBody, url: "./", tag: task_id || "tasktrack" });

  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }));
  return sent;
}

async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_API_KEY) return false;   // email not configured — skip quietly
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject: subject || "TaskTrack", text: text || "" }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
