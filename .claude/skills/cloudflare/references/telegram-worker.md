# If a Telegram Worker gets added

Not built today. The Telegram bot and the payment webhook live in Supabase Edge Functions
(`supabase/functions`, deployed by CI on push to `main`), and they sit next to the
database they read. A Cloudflare Worker for this needs a reason, such as wanting cron work
that does not consume Supabase function invocations, or a webhook endpoint on the same
custom domain as the app.

Keep it as a **separate Worker with its own config file**, not a second entry in this one.
The SPA Worker has no code and no secrets, and it should stay that way: one config means
one deploy unit, and a bot token would then live in the same Worker that serves public
files.

## Shape

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "lunch-order-bot",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-09-22",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "triggers": { "crons": ["0 * * * *"] }
}
```

Deploy with `npx wrangler deploy --config wrangler.bot.jsonc`.

## Cron triggers

Five fields: minute, hour, day-of-month, month, day-of-week, supporting `*`, `,`, `-`,
`/`, and the `L` and `W` extensions. **Execution is UTC**, which matches the pg_cron
convention already used here: schedule hourly in UTC and select the orgs whose local clock
just crossed the threshold, rather than one job per timezone.

Free plan: 5 cron triggers per account, 10 ms CPU per cron invocation. That 10 ms is the
constraint that decides whether this belongs on Workers at all; a job that fans out to
Telegram for many orgs will exceed it.

```ts
export default {
  async scheduled(controller, env, ctx) { /* ... */ },
  async fetch(request, env, ctx) { /* webhook */ },
};
```

Test locally:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"
```

`"crons": []` removes all triggers; commenting the field out does not.
<https://developers.cloudflare.com/workers/configuration/cron-triggers/>

## Secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.bot.jsonc
npx wrangler secret list --config wrangler.bot.jsonc
```

Each `put` creates and deploys a new version. Use `wrangler versions secret put` to stage
one without deploying. In CI, `wrangler deploy --secrets-file <file>` takes JSON or dotenv
and leaves untouched secrets in place.

Local values go in `.dev.vars` (already covered by the `.env*` and `.wrangler/` gitignore
entries). If a `.dev.vars` exists, `.env` is ignored for local dev entirely.
<https://developers.cloudflare.com/workers/configuration/secrets/>

## Webhook notes

Telegram requires HTTPS and a public URL; a workers.dev URL qualifies, as does a route on
the app's custom domain. Verify the `X-Telegram-Bot-Api-Secret-Token` header against a
stored secret rather than trusting the path. Reply fast and push the work to
`ctx.waitUntil`: the 10 ms free-tier CPU budget is per invocation, and Telegram retries a
slow endpoint.

Logs: `npx wrangler tail --config wrangler.bot.jsonc --status error`, or set
`observability.enabled` for retained Workers Logs. Max 10 concurrent tail clients, and
high traffic drops messages to sampling.
<https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>
