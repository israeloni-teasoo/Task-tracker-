# Paste-to-tasks (AI extraction)

The **✨ From text** button turns pasted text — meeting notes, action items, an
email, a summary — into a reviewable list of task suggestions. You confirm/edit
them, then they're saved as tasks (and pushed to Google Calendar if they have a
due date and you're connected). The AI only *extracts*; nothing is saved until
you press **Add tasks**.

## One-time setup (Admin)

1. **Get an Anthropic API key** — <https://console.anthropic.com> → API Keys →
   create a key (`sk-ant-…`). Add a little credit to the account.
2. **Set it as a function secret** — Supabase dashboard → **Edge Functions →
   Secrets** (or `supabase secrets set`):
   - `ANTHROPIC_API_KEY` = `sk-ant-…`
   - *(optional)* `ANTHROPIC_MODEL` = `claude-haiku-4-5` — the default is
     `claude-opus-5` (most capable); **Haiku 4.5 is ~5× cheaper/faster and is
     plenty for this extraction** — recommended for cost.
3. **Deploy the function** — GitHub → **Actions → Deploy Edge Function → Run**
   with `function` = `parse-tasks`.

That's it. The function verifies the signed-in user, calls the Anthropic
Messages API server-side (the key never touches the browser), and returns a
sanitised list of `{title, notes, due, priority}` suggestions.

## Cost

Each extraction is one short API call. With `claude-haiku-4-5` a typical
meeting-notes paste costs a fraction of a cent. Usage is billed to your
Anthropic account; set a spend limit there if you want a hard cap.
