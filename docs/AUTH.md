# Sign-in & email limits

## The two ways to sign in

- **Password** — instant. Set one via **🔑 Set a password** in the app (or when
  prompted after first sign-in). Best for everyday use and new devices.
- **Email link** — a one-time magic link. Good for the very first sign-in on a
  device; after that, set a password so you don't depend on email.

Sessions persist, so you sign in **once per device** and stay logged in.

## "Email rate limit exceeded"

Supabase's **built-in email sender is capped at a few messages per hour** and is
only meant for testing. If you hit this while setting things up:

- **Quickest unblock:** on a device where you're already signed in, click
  **🔑 Set a password**, then use the **Password** tab everywhere else — no email
  involved.
- The limit resets on its own within about an hour.

## Production fix: use your own email sender (SMTP)

So the office/boss get reliable magic-link and password-reset emails, connect a
real email provider once:

1. Pick a provider with a free tier — **Resend**, SendGrid, Mailgun, Postmark,
   or your Google Workspace SMTP.
2. In Supabase → **Authentication → Emails → SMTP Settings**, enable **Custom
   SMTP** and enter the host, port, username, password, and a sender address on
   a domain you control (e.g. `no-reply@teasooconsulting.com`).
3. (Recommended) verify your sending domain with the provider (SPF/DKIM) so mail
   lands in inboxes, not spam.

Once custom SMTP is on, the per-hour cap is set by your provider (far higher),
and links/reset emails are reliable.

### Google Workspace (step by step)

Easiest route — an **App Password** on a sending mailbox in your domain:

1. Pick/create a sending mailbox, e.g. `no-reply@teasooconsulting.com`
   (any real Workspace user works).
2. Turn on **2-Step Verification** for that account:
   myaccount.google.com → **Security** → 2-Step Verification.
3. Create an **App Password**: same Security page → **App passwords** →
   app "Mail" → copy the 16-character code (spaces don't matter).
4. In Supabase → **Authentication → Emails → SMTP Settings** → enable
   **Custom SMTP** and enter:
   - **Host:** `smtp.gmail.com`
   - **Port:** `587`
   - **Username:** `no-reply@teasooconsulting.com`
   - **Password:** the 16-char App Password
   - **Sender email:** `no-reply@teasooconsulting.com`
   - **Sender name:** `MP Office` (or `TaskTrack`)
5. **Save**, then trigger a magic link to test.

### DKIM (recommended — keeps mail out of spam)

1. **Generate the key** in the Google **Admin console** → **Apps → Google
   Workspace → Gmail → Authenticate email** → pick `teasooconsulting.com` →
   **Generate new record** (2048-bit; prefix selector `google`).
2. Google shows a TXT record — **Host** `google._domainkey`, **Value**
   `v=DKIM1; k=rsa; p=…`. Add it in the DNS zone for `teasooconsulting.com`
   (the root domain's DNS, not the Vercel subdomain).
   - If a 2048-bit value is too long for your DNS panel, split it into quoted
     255-char chunks as Google shows, or regenerate as 1024-bit.
3. Back in **Authenticate email**, wait for DNS to propagate, then click
   **Start authentication** (status → "Authenticating email").
4. Verify: send a test, open it in Gmail → **⋮ → Show original** → expect
   **DKIM: PASS** for `teasooconsulting.com`.

### SPF & DMARC

- **SPF:** your domain's TXT should include Google
  (`v=spf1 include:_spf.google.com ~all`) — Workspace domains usually already
  have this.
- **DMARC (recommended):** add a TXT record at **`_dmarc`** with
  `v=DMARC1; p=none; rua=mailto:dmarc@teasooconsulting.com; fo=1` to start
  monitoring, then tighten to `p=quarantine` / `p=reject` once reports look clean.

Limits: `smtp.gmail.com` allows ~2,000 messages/day on Workspace — far more than
you'll need. For very high volume or sending as many different addresses, use
the **SMTP relay service** instead (Admin console → Gmail → Routing → SMTP relay;
host `smtp-relay.gmail.com`, port 587).

## Password resets

If someone forgets their password, they can use the **Email link** tab to sign
in, then set a new password via **🔑 Set a password**. (A dedicated "forgot
password" email flow can be added later; it also relies on email, so configure
SMTP first.)
