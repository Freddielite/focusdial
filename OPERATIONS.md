# Operations

How FocusDial is run, what protects it, and what to do when something
breaks. Keep this current: it's the document whoever is on call reads at
3am, and the one an auditor or a security questionnaire will ask for.

## Architecture in one paragraph

React PWA on Vercel → Express API on Render (one instance) → Postgres on
Supabase. An external scheduler (cron-job.org) calls `/api/cron/tick`
every few minutes for reminders, automations and Google Calendar sync.
Push goes out through Web Push (VAPID); password-reset email through
Wynmail's API (`POST /v1/emails`), which hands it to whichever provider
the Wynmail workspace uses. Google OAuth for "Sign in with Google" and
calendar sync.

## Deploying

1. Open a PR. CI (`.github/workflows/ci.yml`) runs: dependency audit,
   migrations up → down → up on a fresh database, the backend test
   suite, frontend lint and build.
2. Merge to `main`. The `deploy-backend` job triggers Render's deploy
   hook only after CI passes (turn **off** Render auto-deploy and set the
   `RENDER_DEPLOY_HOOK_URL` repo secret). Vercel deploys the frontend
   from `main`; in Vercel → Settings → Git, require the CI checks before
   promoting to production.
3. Pending migrations apply automatically when the new instance boots
   (`MIGRATE_ON_BOOT=true`). Ordinary restarts do no schema work. On a
   paid Render plan, prefer `npm run migrate` as the **pre-deploy
   command** and set `MIGRATE_ON_BOOT=false`.

### Rolling back

- **Code:** Render → the service → Deploys → pick the previous deploy →
  "Rollback". Vercel → Deployments → previous → "Promote to Production".
- **Schema:** `npm run migrate:down` (with production `DATABASE_URL`)
  reverts the most recent migration. Do this *before* rolling the code
  back if the old code can't run against the new schema. The baseline
  migration (001) can't be rolled back - restore from backup instead.

### Writing a migration

Add `backend/src/migrations/NNN_name.js` exporting `up(client)`,
`down(client)` and `name`. Rules that keep migrations from locking the
live tables:

- Runs under `lock_timeout = 5s`: if the table is busy it fails fast;
  just redeploy/retry rather than queueing traffic behind it.
- New index on a big table → `CREATE INDEX CONCURRENTLY` in its own
  migration with `export const transaction = false`.
- New constraint → `ADD CONSTRAINT ... NOT VALID`, then
  `VALIDATE CONSTRAINT` in a later migration.
- New column → nullable or with a constant default (instant in PG ≥ 11).
- Never rename/drop a column the running code still reads: add new,
  deploy code that uses it, drop old in a later release.

## Environment

All configuration is in environment variables - see
`backend/.env.example` for every variable and what it does. Secrets live
only in Render/Vercel's environment settings and a password manager:
never in the repo, never pasted into an AI chat.

## Secrets: rotation

| Secret | How to rotate | Effect |
|---|---|---|
| `SESSION_SECRET` | Set `NEW,OLD`, deploy; remove `OLD` after 30 days | No one is signed out |
| `CRON_SECRET` | Change in Render and in cron-job.org together | Missed ticks catch up |
| `TOKEN_ENCRYPTION_KEY` | Not rotatable in place yet - changing it means users reconnect Google and re-enrol MFA. Don't lose it. | — |
| VAPID keys | Generate new pair; every device must re-enable push | — |
| Google client secret | Google Cloud Console → Credentials → reset | — |
| `WYNMAIL_API_KEY` | Wynmail → API page → create a new key → update Render → revoke the old key | — |
| DB password | Supabase → reset → update `DATABASE_URL` | Brief reconnect |

Rotate everything immediately if any secret was ever committed, pasted
into a chat or a ticket, or was on a lost device. Then check
`git log -p` history - a secret removed in a later commit is still in
history; rotating is the fix, not deleting.

## Backups and restore

The repo can't do this part - it's provider configuration. Do it once,
then keep doing the drill.

- **Nightly backups:** Supabase takes daily backups on paid plans
  (Dashboard → Database → Backups). Confirm they're listed and how long
  they're kept.
- **Point-in-time recovery** (for the `DELETE` without a `WHERE`): a
  Supabase add-on. Turn it on before you need it.
- **Restore drill - quarterly, and after any schema change:** restore
  the latest backup into a *new* project, point a local backend at it
  (`DATABASE_URL=... npm run migrate:status`), sign in as a test account
  and check recent sessions are there. Write the date and how long it
  took in the log below. A backup that's never been restored is a hope.
- **GDPR and backups:** deleted accounts disappear from backups as the
  backups age out of the retention window. Say so in the privacy policy.

Restore drill log:

| Date | Backup restored | Time taken | Result / notes |
|---|---|---|---|
| | | | |

## Monitoring and alerts (set these up - accounts needed)

- **Uptime:** an external checker (UptimeRobot, Better Stack…) on
  `https://<backend>/health/ready` every minute (it checks the database
  too) and on the frontend URL. Alert by email + phone push.
- **Errors:** every 5xx is logged as a JSON line with `level:"error"`,
  a `requestId` (also returned to the client) and the user id. Add a
  Render log drain or an error tracker (Sentry has a free tier) and alert
  on new error types.
- **Cron:** cron-job.org → notify on failure. A tick returns
  `results[]` per user - look for `error` entries.
- **Cost:** set spend alerts in Render, Supabase, Vercel, Google Cloud
  and whatever provider Wynmail sends through, at a level that would surprise you.

## Runbooks

**Site down / `/health/ready` failing**
1. `/health` OK but `/health/ready` 503 → database. Check Supabase
   status and connection count (pool is `PG_POOL_MAX`, default 10).
2. Both failing → Render: logs for `fatal startup error`. A failed
   migration says which file; usually a lock timeout - redeploy.
3. Recent deploy? Roll back (above).

**Reminders not firing** → cron-job.org history (401 = secret mismatch;
202 "previous tick still running" = ticks overlapping, lengthen the
interval). Check VAPID keys are set.

**Password reset emails not arriving** → FocusDial's logs: `mail sent`
(with a Wynmail id) means Wynmail accepted it - look it up in Wynmail.
`mail send failed` gives the reason: 422 the address is suppressed (it
bounced or reported spam before), 429 the workspace's daily cap,
400 sender not approved in Wynmail, 401 bad/revoked API key, 5xx/0
Wynmail down or asleep (retried twice, then given up). If Wynmail is on
a free Render instance, its cold start can take most of a minute; the
mailer waits up to 60s per attempt.

**"Too many attempts" complaints** → rate limits are in-memory per
instance and reset on restart; a legitimate user can always use
"Forgot password?", which has its own budget.

**Suspected account compromise** → (as the user, or via SQL as admin)
revoke sessions: `DELETE FROM user_sessions WHERE sess->>'userId' = '<id>'`;
check `SELECT * FROM audit_log WHERE user_id = '<id>' ORDER BY created_at DESC`.

**Lost/stolen laptop with production access** → from another device:
rotate the DB password, `SESSION_SECRET` (without keeping the old one -
signs everyone out), `CRON_SECRET`, Google client secret, the Wynmail API key;
revoke the laptop's GitHub/Render/Vercel/Supabase sessions and tokens;
review the audit log and Render/Supabase access logs for the window.

**Vulnerability report** → SECURITY.md.

After any incident, write a short postmortem (what happened, impact,
timeline, root cause, and the one or two changes that stop it recurring)
in `docs/postmortems/` and link it here.

## Security controls (current)

- Passwords: bcrypt cost 12, 8–72 bytes. Generic login errors.
- Login rate limits: per IP+email, per IP, per email (in-memory - move
  to Postgres/Redis if you ever run >1 instance).
- Sessions: server-side (Postgres), httpOnly + Secure + SameSite cookie,
  id rotated at login, 14-day idle / 30-day absolute expiry, revocable
  per user ("sign out everywhere"), revoked on password change/reset.
- MFA: TOTP with replay protection + 10 single-use recovery codes.
- Password reset: hashed single-use tokens, 30-minute expiry, no account
  enumeration.
- Google sign-in: `state` (anti-CSRF), links to an existing account only
  for Google-verified emails.
- Authorization: every query is scoped by `user_id`; references to other
  rows are ownership-checked centrally (`lib/ownership.js`). Tested.
- CSRF: Origin allow-list on state-changing requests + CORS allow-list.
- Input: type/length validation on every field (`lib/validate.js`);
  parameterized SQL everywhere; DB CHECK constraints.
- Idempotency keys on POSTs; transactional, row-locked state transitions.
- Headers: Helmet on the API; CSP, HSTS, frame-ancestors etc. on the
  frontend (`frontend/vercel.json`).
- At rest: provider disk encryption + AES-256-GCM for OAuth tokens and
  MFA secrets. In transit: HTTPS, DB TLS (verified with `DATABASE_SSL_CA`).
- Logs: structured, credentials redacted, secrets stripped from URLs.
- Audit log of security events, kept 365 days; users can see their own.
- Dependencies: `npm audit` gate in CI, Dependabot monthly.

## Things only a person can do (checklist)

- [ ] Accounts in the company's name, not a personal one: GitHub org,
      Render, Vercel, Supabase, Google Cloud, Wynmail, domain registrar,
      cron-job.org. At least two people with owner access to each
      (bus factor > 1), with MFA on.
- [ ] Branch protection on `main`: PR required, CI required, code-owner
      review (`.github/CODEOWNERS`), no force-push.
- [ ] Supabase backups confirmed + PITR on + first restore drill logged.
- [ ] Uptime checks, error alerts, cost alerts (above).
- [ ] A Wynmail workspace for FocusDial with an approved sending domain
      (SPF, DKIM and DMARC passing - Wynmail's domain check shows this),
      a From address on that domain, and its bounce/complaint webhooks
      connected so bad addresses get suppressed. Send yourself a reset
      email and check it lands in the inbox, not spam.
- [ ] Google OAuth consent screen published and verified before real
      users connect calendars ("Testing" mode: 100 listed users, refresh
      tokens expire after 7 days).
- [ ] Terms of service and a privacy policy that match what the code
      does (what's stored, Google data use, deletion, backups, sub-
      processors: Render, Vercel, Supabase, Google, and the email provider
      behind Wynmail). Link both
      from the sign-up screen.
- [ ] Replace the placeholder contact in SECURITY.md.
- [ ] Render paid instance once people depend on it: the free tier
      sleeps (30–50s cold starts) and has 512 MB RAM.
