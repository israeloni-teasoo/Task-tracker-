# Database migrations

Schema changes live here so they can be applied **without pasting SQL** — and
**without Docker**.

- `migrations/` — **forward migrations**, applied in filename order. Each is
  idempotent (`create or replace`, `if not exists`, `drop policy if exists`…),
  so re-running one is always safe.
- `baseline_schema.sql` — the complete current schema, for standing up a
  **brand-new** project from scratch. Not auto-applied.
- `config.toml` — minimal CLI config.

> The paste-style copies in `../backend/migrations/` are kept for the
> SQL-editor workflow and history.

## Recommended: GitHub Action (no local tools at all)

A workflow applies pending migrations from GitHub with a button click.

**One-time:**
1. Create a Supabase **personal access token**: Supabase dashboard → account →
   **Access Tokens** → generate (starts `sbp_…`).
2. In GitHub → repo **Settings → Secrets and variables → Actions → New
   repository secret**: name `SUPABASE_ACCESS_TOKEN`, value = that token.

**Each time there's a schema change:**
- GitHub → **Actions** tab → **Apply DB migrations** → **Run workflow**.

It runs `scripts/apply-migrations.mjs`, which records applied files in a
`public.applied_migrations` table and runs only new ones. The workflow is
**manual only** — it never fires on a push.

## Alternative: one command locally (no Docker, no CLI)

Needs only Node + the token in your environment:

```bash
# PowerShell
$env:SUPABASE_ACCESS_TOKEN="sbp_xxx"
$env:SUPABASE_PROJECT_REF="tlapegutuiaikhbjhhkg"
node scripts/apply-migrations.mjs
```

```bash
# macOS/Linux
export SUPABASE_ACCESS_TOKEN=sbp_xxx
export SUPABASE_PROJECT_REF=tlapegutuiaikhbjhhkg
node scripts/apply-migrations.mjs
```

## Alternative: the Supabase CLI (no Docker needed for this)

`supabase db push` talks directly to the hosted DB — Docker is only for the
local stack (`supabase start` / `db reset` / `db diff`), which you don't need.

```bash
npm install -g supabase
supabase login
supabase link --project-ref tlapegutuiaikhbjhhkg
supabase db push
```

## Simplest of all: SQL editor

Paste a migration file into the Supabase dashboard → SQL editor → Run. Zero
setup; good for a one-off.

## Everyday flow

1. Claude adds a new idempotent file to `supabase/migrations/`.
2. You apply it via **any** route above (Action button, `node`, `db push`, or paste).

Keep the access token on your machine / in the GitHub secret only — it grants
project admin, so never commit it or paste it into chat.
