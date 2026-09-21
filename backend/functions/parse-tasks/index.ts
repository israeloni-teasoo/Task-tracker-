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
//   and optional GEMINI_MODEL (pins a single model; unset = try a fallback
//   chain of current models — see MODELS below).

import { createClient } from "npm:@supabase/supabase-js@2";

// build: v5 (resilient model fallback + transient retry; diag reports the
// model that actually answered)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Candidate models tried in order. If GEMINI_MODEL is set it wins; otherwise we
// try current names and fall through on "model not found/retired" (404) so a
// single retired model (as happened with gemini-2.0-flash) can't break the
// feature. Order: a stable alias first, then explicit current names.
const MODELS = Deno.env.get("GEMINI_MODEL")
  ? [Deno.env.get("GEMINI_MODEL")!]
  : ["gemini-flash-latest", "gemini-3.6-flash", "gemini-2.5-flash"];

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Call Gemini generateContent, trying each candidate model in turn. Falls
// through to the next model on a 404 (model not found/retired); retries the
// same model once after a short delay on a transient 503/429. Returns the raw
// Response + parsed JSON of the first model that answers (ok or a non-transient
// error), plus which model was used.
async function callGemini(payload: unknown, models = MODELS): Promise<{ res: Response; data: any; model: string }> {
  let last: { res: Response; data: any; model: string } | null = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      last = { res, data, model };
      if (res.ok) return last;
      if ((res.status === 503 || res.status === 429) && attempt === 0) { await sleep(900); continue; } // transient: retry same model once
      break; // non-transient (or already retried): try the next model
    }
    if (last && (last.res.status === 404)) continue; // model retired/not found: next candidate
    if (last && !last.res.ok && last.res.status !== 503 && last.res.status !== 429) break; // real error (e.g. bad key): stop
  }
  return last!;
}

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

  const bodyIn = await req.json().catch(() => ({} as any));

  // TEMP diagnostics (unauthenticated): confirms, server-side, whether THIS
  // isolate can see the GEMINI_API_KEY secret and whether a live Gemini call
  // with the configured key+model actually succeeds. Never returns the key
  // value itself. Remove once paste-to-tasks is confirmed working.
  if (bodyIn && bodyIn.action === "diag") {
    const models = (typeof bodyIn.model === "string" && bodyIn.model) ? [bodyIn.model] : MODELS;
    let gemini = "skipped (no key)", usedModel = models[0];
    if (GEMINI_API_KEY) {
      try {
        const { res, data, model } = await callGemini({ contents: [{ role: "user", parts: [{ text: "Reply with the word ok." }] }] }, models);
        usedModel = model;
        gemini = res.ok
          ? "ok: " + ((data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim() || "(empty)")
          : `error ${res.status}: ${data?.error?.message || "unknown"}`;
      } catch (e) { gemini = "fetch_failed: " + String((e as Error)?.message || e); }
    }
    return json({ hasKey: !!GEMINI_API_KEY, candidates: models, model: usedModel, gemini });
  }

  if (!GEMINI_API_KEY) return json({ error: "not_configured", message: "Set the GEMINI_API_KEY secret on this function." }, 400);
  const uid = await userId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const { text } = bodyIn;
  if (!text || typeof text !== "string" || !text.trim()) return json({ error: "no_text" }, 400);
  if (text.length > 20000) return json({ error: "too_long", message: "Paste up to ~20,000 characters at a time." }, 400);

  const today = new Date().toISOString().slice(0, 10);
  try {
    const { res, data } = await callGemini({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `Today is ${today}.\n\nExtract tasks from:\n\n${text}` }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 },
    });
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
