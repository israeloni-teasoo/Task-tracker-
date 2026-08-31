// Supabase Edge Function: send-push
// Sends a Web Push notification to every device of the owners + delegates.
// Deploy with the Supabase CLI (see docs/NOTIFICATIONS.md) and set the secrets
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT.
//
// It is called (e.g. by a DB trigger on a nudge) with JSON: { task_id } or
// { title, body }.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY")!;
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY")!;
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
const admin = createClient(supabaseUrl, serviceKey);

Deno.serve(async (req) => {
  try {
    const { task_id, title, body } = await req.json().catch(() => ({}));

    // Recipients: everyone who acts on the boss's behalf.
    const { data: staff } = await admin.from("memberships").select("user_id").in("role", ["owner", "delegate"]);
    const ids = (staff || []).map((s) => s.user_id);
    if (!ids.length) return json({ sent: 0 });

    let msgTitle = title || "TaskTrack";
    let msgBody = body || "Something needs your attention.";
    if (task_id && !body) {
      const { data: t } = await admin.from("tasks").select("title").eq("id", task_id).maybeSingle();
      if (t) msgBody = `"${t.title}" was nudged and needs your attention.`;
    }

    const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", ids);
    const payload = JSON.stringify({ title: msgTitle, body: msgBody, url: "./", tag: task_id || "tasktrack" });

    let sent = 0;
    await Promise.all((subs || []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e: any) {
        // Clean up expired/invalid subscriptions.
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }));

    return json({ sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
