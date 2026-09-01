#!/usr/bin/env node
/**
 * Apply pending SQL migrations to Supabase via the Management API.
 *
 * Usage:
 *   export SUPABASE_ACCESS_TOKEN=sbp_xxx          # personal access token (keep local!)
 *   export SUPABASE_PROJECT_REF=tlapegutuiaikhbjhhkg
 *   node scripts/apply-migrations.mjs
 *
 * It records applied files in a small table (public.applied_migrations) and runs
 * only the ones it hasn't run yet, in filename order. Requires Node 18+ (global fetch).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF first.");
  process.exit(1);
}

const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

async function runSQL(query) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

async function main() {
  await runSQL(
    "create table if not exists public.applied_migrations (name text primary key, applied_at timestamptz default now());"
  );
  const rows = await runSQL("select name from public.applied_migrations;");
  const list = Array.isArray(rows) ? rows : (rows.result || rows.rows || []);
  const applied = new Set(list.map((r) => r.name));

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    process.stdout.write(`Applying ${f} … `);
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    await runSQL(sql);
    await runSQL(`insert into public.applied_migrations(name) values ('${f.replace(/'/g, "''")}');`);
    console.log("done");
    ran++;
  }
  console.log(ran ? `Applied ${ran} migration(s).` : "Nothing to apply — up to date.");
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
