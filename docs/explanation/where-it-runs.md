# Where it runs

Why the app is a static bundle talking straight to Postgres, and why it is hosted
where it is.

## The shape

- **Postgres on Supabase.** The browser talks to it directly and org-scoped RLS
  is the security boundary. Business rules that need legible error messages
  (order cutoff, menu lifecycle, transfer transitions) are triggers rather than
  policies.
- **Edge Functions (Deno)** only for what must never reach the browser: the
  Telegram bot, the SePay payment webhook, the outbox drain that sends Telegram
  messages, and the AI menu reader.
- **pg_cron** for scheduling. Jobs run hourly in UTC and select the orgs whose
  local clock has just crossed a threshold, so a customer in a new timezone
  needs no new job.
- **React + Vite** SPA, served as static assets by a Cloudflare Worker. There is
  no Worker script: the bundle talks to Supabase directly, so nothing needs to
  run at the edge.

## Why Cloudflare and not Vercel

Vercel's Hobby plan is non-commercial use only, and this is a company internal
tool. Cloudflare's free static asset bandwidth is unmetered and permits
commercial use.

## Why it is not part of nexus-infra

This started inside the `nexus-infra` working tree and was split out into its
own repository. It shares none of that project's conventions and must not call
anything in it.

The split was not cosmetic. GitHub Actions only reads workflows from the
repository root, so while this lived at `app/lunch-order/` inside `nexus-infra`,
its CI had never once executed.

## Related

- [Set up a deployment](../how-to/set-up-a-deployment.md)
- [Decisions: Platform](../decisions.md#platform)
