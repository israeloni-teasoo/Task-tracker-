// Supabase Edge Function: invite-user
// The Owner calls this from the People screen to invite someone to the MAIN APP.
// It (1) verifies the caller is an Owner, (2) records the role they chose, and
// (3) sends an official invite email with a sign-in link. Because it uses the
// service role, it works even when public sign-up is turned OFF — which is how
// the app stays invitation-only while /office remains open to everyone.
//
// Deploy it and set the (optional) APP_URL secret — see docs/AUTH.md.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const APP_URL = Deno.env.get("APP_URL") || "https://mp-office.teasooconsulting.com";
const ROLES = ["owner", "delegate", "editor", "viewer", "requester"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Who is calling? Validate their access token.
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Please sign in again." }, 401);

    // Only an Owner may invite.
    const { data: mem } = await admin.from("memberships").select("role").eq("user_id", caller.user.id).maybeSingle();
    if (!mem || mem.role !== "owner") return json({ error: "Only an Owner can invite people." }, 403);

    const { email, role } = await req.json().catch(() => ({}));
    const clean = String(email || "").trim().toLowerCase();
    if (!clean || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return json({ error: "Enter a valid email address." }, 400);
    if (!ROLES.includes(role)) return json({ error: "Pick a valid role." }, 400);

    // Record the role first so the sign-up trigger assigns it when they accept.
    await admin.from("role_invites").upsert({ email: clean, role, invited_by: caller.user.id }, { onConflict: "email" });

    // Send the invite email (creates the account + a one-time link back to the app).
    const { error } = await admin.auth.admin.inviteUserByEmail(clean, { redirectTo: APP_URL });
    if (error) {
      // Most common: the person already has an account. Their role was still
      // updated above, so tell the caller to have them just sign in.
      return json({ ok: true, alreadyExists: true, message: error.message });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });
}
