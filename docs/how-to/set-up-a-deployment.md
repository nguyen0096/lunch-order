# Set up a deployment

From nothing to a push on `main` that deploys itself. Do this once per
environment; after it, there is no manual step. What each value is and why it
lives where it does is in [Secrets](../reference/secrets.md).

## What a push to main does

`.github/workflows/ci.yml` typechecks, runs the tests and `deno check`s the Edge
Functions. When that passes on `main`, `.github/workflows/deploy.yml`:

1. builds `dist/web` and uploads it to the `lunch-order` Worker as static assets;
2. deploys all four Edge Functions (`outbox-drain`, `parse-assist`, `sepay`,
   `telegram`) with `supabase functions deploy`;
3. publishes a GitHub release named for the date, listing the commits since the
   last one.

Migrations are applied separately, by the Supabase GitHub integration.

Routing is hash based, so `index.html` is the only HTML entry point and no
history fallback is configured; a 404 from the Worker means a genuinely missing
file.

## 1. Create the Worker

From a machine logged in with `npx wrangler login`:

```bash
npm run deploy
```

The first deploy creates `lunch-order` and prints its
`https://lunch-order.<your-subdomain>.workers.dev` URL, which step 5 needs. The
same command later ships a build without CI, or checks one before merging.

## 2. Generate the two shared secrets

```bash
openssl rand -hex 32    # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32    # OUTBOX_DRAIN_SECRET
```

## 3. Edge Function secrets

`--project-ref` avoids needing `supabase link`. Lead with a space to keep the
tokens out of shell history.

```bash
 npx supabase secrets set \
   TELEGRAM_BOT_TOKEN='<from BotFather>' \
   TELEGRAM_WEBHOOK_SECRET='<step 2>' \
   OUTBOX_DRAIN_SECRET='<step 2>' \
   DEEPSEEK_API_KEY='<optional, for Read with AI>' \
   --project-ref wvtbstticnactealupph
```

## 4. Vault, so pg_cron can reach the drain

Run in the SQL editor:

```sql
select vault.create_secret('https://<ref>.supabase.co',   'project_url');
select vault.create_secret('<publishable key>',           'publishable_key');
select vault.create_secret('<OUTBOX_DRAIN_SECRET>',       'outbox_drain_secret');
```

## 5. GitHub settings

```bash
gh secret   set SUPABASE_ACCESS_TOKEN   --repo <owner>/lunch-order
gh secret   set CLOUDFLARE_API_TOKEN    --repo <owner>/lunch-order
gh secret   set CLOUDFLARE_ACCOUNT_ID   --repo <owner>/lunch-order
gh variable set VITE_SUPABASE_URL       --repo <owner>/lunch-order --body 'https://<ref>.supabase.co'
gh variable set VITE_SUPABASE_PUBLISHABLE_KEY --repo <owner>/lunch-order --body 'sb_publishable_...'
gh variable set VITE_TELEGRAM_BOT       --repo <owner>/lunch-order --body '<bot username, no @>'
```

The Cloudflare token comes from the *Edit Cloudflare Workers* template; the
Supabase one from
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

The `release` job needs to create tags. Under *Settings > Actions > General >
Workflow permissions*, either choice works because the job asks for
`contents: write` itself, but an organization policy that caps tokens at
read-only will fail it.

## 6. Allow the origin in Supabase Auth

Google sign-in passes `redirectTo: window.location.origin`, so add the Worker
URL from step 1 under *Authentication > URL Configuration > Redirect URLs*. Until
you do, sign-in completes at Google and then bounces to the project's default
site URL.

## 7. Deploy the functions, then point Telegram at them

Order matters: registering the webhook before the function exists means every
update Telegram sends lands on a 404. Push to `main`, or deploy by hand as in
[Deploy the Edge Functions](deploy-edge-functions.md), then:

```bash
curl -sX POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<ref>.supabase.co/functions/v1/telegram",
       "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates":["message","callback_query"],
       "drop_pending_updates":true}'
```

## 8. Per office

Each office has settings that stay empty until an admin fills them, and each
empty one quietly disables a feature:

- **Where the money goes.** Until `payment_config` is set, no bill shows a QR.
  See [Set up where the money goes](set-up-payment.md).
- **Bank transfers that record themselves.** Needs a SePay account and the
  office's own webhook key in `public.org_webhook_secrets`. See
  [Connect SePay](connect-sepay.md).
- **The Telegram group.** Until `telegram_group_chat_id` is set, nothing is
  posted to the group.

## 9. Verify

```bash
npx supabase secrets list --project-ref <ref>     # names only, never values
gh secret list --repo <owner>/lunch-order
gh variable list --repo <owner>/lunch-order
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"   # url set, last_error_message empty
```

```sql
select name from vault.secrets order by name;
select j.jobname, d.status, max(d.end_time)
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 group by j.jobname, d.status;
```

Before shipping, confirm nothing secret reached the bundle:

```bash
grep -rn "SERVICE_ROLE\|BOT_TOKEN\|sb_secret_" dist/web/
```

## Related

- [Secrets](../reference/secrets.md)
- [Deploy the Edge Functions](deploy-edge-functions.md), including what to check
  when a function is deployed but nothing happens
- [Where it runs](../explanation/where-it-runs.md), for why Cloudflare and not Vercel
