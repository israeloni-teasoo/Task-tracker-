# TaskTrack — Security Assessment

_Last reviewed: 2026-09-02. Reviewer: security pass over the whole project, from
an attacker's perspective and against OWASP Top 10 (2021) and STRIDE._

> **Update (2026-09-03):** the public `/office` page was removed — the app is now
> invitation-only and everyone signs in. References below to `/office`,
> `request.html`, and anonymous request submission are historical; the anon
> insert policy and `public_*` RPCs remain in the schema but are no longer
> reachable from a shipped page. Roles now display "Admin" for the `owner` value.

## 1. What we're securing (scope & architecture)

TaskTrack has **no custom application server**. That removes a whole class of
bugs (no Express/route handlers to exploit) and shifts the security boundary to
two managed platforms:

- **Frontend** — static HTML/CSS/JS on **Vercel** (`index.html`, `request.html`
  at `/office`). All logic runs in the browser.
- **Backend** — **Supabase**: Postgres + Auth + PostgREST (the REST API) +
  Row-Level Security (RLS) + a couple of `security definer` RPCs + an optional
  Edge Function for web-push.

The browser talks to Supabase with the **publishable ("anon") key**, which is
*designed to be public*. **Row-Level Security is therefore the real security
control** — not the key. Most of this review is about verifying RLS and the
handful of places that bypass it (definer functions, the anon insert policy).

References: OWASP Top 10 2021 (`owasp.org/Top10`), STRIDE (Microsoft threat
model), OWASP Secure Headers Project, Supabase RLS docs.

## 2. Attacker's-eye walkthrough (what I tried to break)

| Attack | Result |
| --- | --- |
| Read other users' tasks with the anon key | **Blocked.** `tasks` SELECT policy requires `is_staff()` or `requester_id = auth.uid()`; anonymous callers match neither and get `[]`. |
| Anonymous write to arbitrary tables | **Blocked.** Only one anon policy exists — `tasks_insert_public` — and it's *insert-only* with strict `WITH CHECK` (must be a pending request, no owner, size-capped). No anon UPDATE/DELETE/SELECT anywhere. |
| Escalate my own role (requester → owner) | **Blocked.** `memberships` write policy is `is_owner()` only; a requester can't change roles. |
| Self-invite to a high role | **Blocked.** `role_invites` is owner-only (RLS); the sign-up trigger only *consumes* an invite an owner created. |
| Brute-force the public status/nudge tokens | **Infeasible.** `track_token` is a UUIDv4 (~122 bits). The definer RPCs (`public_request_status`, `public_nudge`) return/act on exactly one row matched by that token. |
| Stored XSS via a task/name/project field | **Fixed this pass.** All user text is HTML-escaped on render; the one gap — a project **colour** interpolated into `style=` — is now sanitised to a hex whitelist. Verified a crafted colour no longer injects markup. |
| Trigger the boss's push notifications by calling the Edge Function URL | **Fixed this pass.** The function now requires a shared `x-webhook-secret`; unauthenticated callers get 401. |
| Steal secrets from the repo or client | **None found.** Only the publishable key + VAPID *public* key ship to the browser (both public by design). Service-role key and VAPID *private* key are server-only env vars; the migration token lives in a GitHub secret. |
| SQL injection | **Not reachable.** The app never builds SQL; it uses PostgREST (parameterised) and typed RPCs (`uuid`). |
| Spam the open `/office` link | **Mitigated.** Field sizes are capped in the DB; a client cooldown throttles submissions; Supabase rate-limits at the edge. See recommendations for CAPTCHA. |

## 3. OWASP Top 10 (2021) status

- **A01 Broken Access Control** — Primary control is RLS on **all 8 tables**,
  deny-by-default, with server-side role checks (`is_owner`/`can_edit`/…). The
  UI also hides controls by role, but that's UX only; the DB enforces. ✅
- **A02 Cryptographic Failures** — HTTPS everywhere (Vercel + Supabase) + HSTS
  now set. Passwords are hashed by Supabase Auth (bcrypt) and never stored by
  us. Capability tokens are UUIDv4. ✅
- **A03 Injection** — No raw SQL; output is HTML-escaped (`esc`) and colours
  whitelisted (`col`); a strict CSP is set. ✅
- **A04 Insecure Design** — Least-privilege roles, capability-token model for the
  accountless public link, insert-only anon, defense-in-depth. ✅
- **A05 Security Misconfiguration** — Added CSP, HSTS, `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP. RLS on
  every table. See §5 for Supabase-side settings still recommended. ✅ / see §5
- **A06 Vulnerable & Outdated Components** — No runtime npm deps; the Supabase
  client is vendored at a pinned version; Dependabot keeps the GitHub Actions
  patched. Refresh the vendored lib periodically. ✅
- **A07 Identification & Auth Failures** — Supabase Auth (magic-link + password),
  persistent sessions with refresh tokens. Recommend MFA/CAPTCHA/leaked-password
  protection (§5). ✅ / see §5
- **A08 Software & Data Integrity** — Service-worker updates are same-origin and
  user-confirmed; migrations are idempotent and tracked. Enable GitHub push
  protection (§5). ✅
- **A09 Logging & Monitoring** — Supabase provides auth/DB logs; nudges are
  recorded in `task_events`. Recommend enabling alerts + a fuller status-change
  audit (§5). ⚠️
- **A10 SSRF** — No user-controlled server-side fetch. The Edge Function calls
  fixed hosts only. N/A. ✅

## 4. STRIDE summary

- **Spoofing** → Supabase JWT auth; owner-only invites. Harden with CAPTCHA +
  leaked-password checks (§5).
- **Tampering** → RLS + `WITH CHECK` policies + definer triggers; input size caps.
- **Repudiation** → `created_at`/`updated_at`, nudge events; add status-change
  audit for completeness (§5).
- **Information Disclosure** → RLS deny-by-default, capability tokens, no client
  secrets, `Referrer-Policy`, tight CSP `connect-src`.
- **Denial of Service** → DB field caps, client cooldown, Supabase edge limits;
  add CAPTCHA on signup and the public form (§5).
- **Elevation of Privilege** → role changes owner-only; definer functions pin
  `search_path`; requesters can't update tasks; anon is insert-only; XSS closed.

## 5. Recommended follow-ups (need a few clicks in Supabase / GitHub)

These aren't code — they're settings only you can toggle:

1. **Apply migration 009** (`harden_public_insert`) via the *Apply DB migrations*
   Action, so the field-size caps are live.
2. **Supabase → Authentication → Providers/Policies:**
   - Enable **leaked-password protection** (checks HaveIBeenPwned).
   - Set a **minimum password length** (≥ 8).
   - Enable **CAPTCHA / Attack Protection** (e.g. Turnstile) — the app allows
     open sign-up (new users become *Requester*), so a CAPTCHA stops bot signups
     and throttles the magic-link/OTP endpoints.
   - Consider **MFA** for Owner/Delegate accounts.
   - Configure **custom SMTP** (see `docs/AUTH.md`) so email limits don't block
     logins.
3. **Session length** — the default access-token expiry (1h) + refresh is fine;
   shorten it in Auth settings if you want tighter sessions.
4. **GitHub → Settings → Code security:** turn on **Secret scanning** and **Push
   protection** so a key can never be committed by accident.
5. **Rotate** the Supabase personal access token used by the migration Action
   periodically; it lives only in the `SUPABASE_ACCESS_TOKEN` repo secret.
6. **Backups** — enable Supabase point-in-time recovery / verify daily backups.
7. **Monitoring** — skim Supabase Auth & Postgres logs; set up an alert on
   unusual auth failures.

## 6. What changed in this security pass

- **Security headers** added in `vercel.json`: strict **CSP** (`script-src
  'self'`), **HSTS**, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, COOP.
- **Inline scripts externalised** (`theme-init.js`, `sw-register.js`) so the CSP
  needs no `unsafe-inline` for scripts.
- **Stored-XSS fix**: project colours are sanitised to a hex whitelist (`col()`).
- **Public insert hardened**: size caps on name/department/title/notes
  (`migration 009`).
- **Edge Function auth**: `send-push` requires a shared `x-webhook-secret`.
- **Abuse throttle**: client cooldown on the `/office` submit and reminder.
- **Dependency hygiene**: Dependabot for GitHub Actions.

## Reporting a vulnerability

Found something? Email the maintainer rather than opening a public issue, and
allow reasonable time to remediate before disclosure.
