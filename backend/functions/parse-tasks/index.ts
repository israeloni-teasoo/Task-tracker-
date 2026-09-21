// Supabase Edge Function: parse-tasks
// Turns a blob of pasted text (notes, action items, a meeting summary) into a
// structured list of task suggestions using the Google Gemini API (free tier).
// The user reviews and confirms them in the app before anything is saved — this
// function only extracts, it never writes to the database.
//
// Deploy with --no-verify-jwt (the shared Deploy Edge Function action does);
// it authenticates the caller itself so only signed-in users can use it.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), GEMINI_API_KEY,
//   and optional GEMINI_MODEL (default gemini-2.0-flash).

import { createClient } from "npm:@supabase/supabase-js@2";

// build: v2 (force fresh isolate so a newly-set GEMINI_API_KEY is picked up)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function userId(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

const SYSTEM = `You extract actionable tasks from text a user pastes — meeting notes, action items, an email, or a summary. Return ONLY a JSON array (no prose). Each element:
{"title": string (short, imperative), "notes": string ("" if none), "due": ISO 8601 datetime or null, "priority": "high"|"medium"|"low" or null}
Rules:
- One task per distinct action item. Ignore greetings, headings, and non-actionable context.
- Resolve relative dates ("tomorrow", "next Friday 3pm", "EOD Monday") against the provided "Today" date; if only a date is given, use that date with no specific time; if no date is mentioned, use null.
- Infer priority only when clearly implied ("urgent", "ASAP", "critical" -> high); otherwise null.
- Keep titles concise; put extra detail in notes. If nothing actionable, return [].`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!GEMINI_API_KEY) return json({ error: "not_configured", message: "Set the GEMINI_API_KEY secret on this function." }, 400);
  const uid = await userId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const { text } = await req.json().catch(() => ({}));
  if (!text || typeof text !== "string" || !text.trim()) return json({ error: "no_text" }, 400);
  if (text.length > 20000) return json({ error: "too_long", message: "Paste up to ~20,000 characters at a time." }, 400);

  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: `Today is ${today}.\n\nExtract tasks from:\n\n${text}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 },
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error("gemini error", data); return json({ error: "model_error", message: data?.error?.message || "The AI request failed." }, 502); }
    if (data.promptFeedback?.blockReason) return json({ error: "blocked", message: "The request was blocked." }, 400);

    const textOut = (data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
    let tasks: any[] = [];
    try {
      const jsonStr = textOut.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      tasks = JSON.parse(jsonStr);
    } catch (_) { return json({ error: "parse_failed", message: "Couldn't read the AI's response — try again." }, 502); }
    if (!Array.isArray(tasks)) tasks = [];

    const clean = tasks.slice(0, 50).map((t) => ({
      title: String(t?.title || "").slice(0, 300).trim(),
      notes: String(t?.notes || "").slice(0, 2000).trim(),
      due: typeof t?.due === "string" && !isNaN(Date.parse(t.due)) ? t.due : null,
      priority: ["high", "medium", "low"].includes(t?.priority) ? t.priority : null,
    })).filter((t) => t.title);

    return json({ tasks: clean });
  } catch (e) {
    console.error("parse-tasks error", e);
    return json({ error: "server_error", message: String((e as Error)?.message || e) }, 500);
  }
});
