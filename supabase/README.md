# Database migrations (Supabase CLI)

The database schema and its changes live here so they can be applied with **one
command** instead of pasting SQL.

- `migrations/20250901120000_init.sql` — the complete current schema (tables,
  roles, RLS, functions, triggers). Use this to stand up a **fresh** project.
- Future changes are added as **new timestamped files** in `migrations/`. The
  CLI applies any that haven't run yet.

> The older paste-style files in `../backend/migrations/` are kept for reference
> and for the copy-into-SQL-editor workflow. Going forward, prefer the CLI.

## No Docker? No problem

Docker is **only** needed for the local dev stack (`supabase start`, `db reset`,
`db diff`). Everything below syncs to the **hosted** project without it:

- **Option A — SQL editor (zero setup).** Paste a migration file into the
  Supabase dashboard → SQL editor → Run. Fine for occasional changes.
- **Option B — one command, no Docker, no CLI.** `node scripts/apply-migrations.mjs`
  (needs only Node + a personal access token in your environment — see the
  bottom of this file). This is the recommended everyday option if the CLI is
  giving you trouble.
- **Option C — the CLI, no Docker.** `supabase link` + `supabase db push` talk
  directly to the remote DB and do **not** need Docker. Just don't run
  `supabase start` / `db reset` / `db diff` (those are the Docker-only ones).
- **Option D — GitHub Action.** Apply migrations automatically from CI so you
  run nothing locally (ask Claude to set this up).

## One-time setup (CLI — Option C)

```bash
# 1. Install the CLI (pick one)
npm install -g supabase          # or: brew install supabase/tap/supabase

# 2. Log in and link this repo to the project
supabase login
supabase link --project-ref tlapegutuiaikhbjhhkg
```

## Adopting the CLI on the EXISTING (live) project

The live database already has the schema, so **baseline** it first — this
records the current state as "already applied" so `db push` won't try to re-run
it:

```bash
supabase db pull        # introspects the remote DB and writes/marks a baseline
```

Then apply anything newer (e.g. the touch_task fix) — if you haven't already
pasted it:

```bash
supabase db push        # runs only migrations not yet applied
```

## Standing up a BRAND-NEW project

```bash
supabase link --project-ref <new-ref>
supabase db push        # runs migrations/ in order (starts with the init baseline)
```

## Everyday flow (after setup)

1. Claude adds a new file to `supabase/migrations/` (e.g.
   `20250115090000_add_labels.sql`).
2. You run:

   ```bash
   supabase db push
   ```

That's it — no copy-pasting into the SQL editor.

## Alternative: one-command apply without the CLI

`../scripts/apply-migrations.mjs` applies pending files via the Supabase
Management API using a token read from your environment (never committed):

```bash
export SUPABASE_ACCESS_TOKEN=sbp_xxx        # a personal access token, kept local
export SUPABASE_PROJECT_REF=tlapegutuiaikhbjhhkg
node scripts/apply-migrations.mjs           # runs any *.sql it hasn't recorded yet
```

Keep that token on your machine only — it grants project admin. Prefer the CLI
above for day-to-day work.
