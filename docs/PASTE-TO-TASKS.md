# Paste-to-tasks (AI extraction)

The **✨ From text** button turns pasted text — meeting notes, action items, an
email, a summary — into a reviewable list of task suggestions. You confirm/edit
them, then they're saved as tasks (and pushed to Google Calendar if they have a
due date and you're connected). The AI only *extracts*; nothing is saved until
you press **Add tasks**.

Uses **Google Gemini** (generous free tier) via the `parse-tasks` Edge Function.

## One-time setup (Admin)

1. **Get a Gemini API key (free):** <https://aistudio.google.com/apikey> →
   *Create API key*. The free tier covers this comfortably.
2. **Set it as a function secret** — Supabase dashboard → **Edge Functions →
   Secrets** (or `supabase secrets set`):
   - `GEMINI_API_KEY` = your key
   - *(optional)* `GEMINI_MODEL` = pin one model (e.g. `gemini-flash-latest`).
     Leave it unset and the function tries a fallback chain of current fast
     models (`gemini-flash-latest`, `gemini-3.6-flash`, `gemini-2.5-flash`),
     so a single retired or overloaded model can't break extraction.
3. **Deploy the function** — GitHub → **Actions → Deploy Edge Function → Run**
   with `function` = `parse-tasks`.

That's it. The function verifies the signed-in user, calls the Gemini API
server-side (the key never touches the browser), and returns a sanitised list of
`{title, notes, due, priority}` suggestions.

## Cost

The Gemini free tier handles this with no billing set up. Each extraction is one
short call. If you ever exceed the free quota, add billing in Google AI Studio —
usage stays tiny for note-to-task extraction.
