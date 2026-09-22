---
name: cloudflare
description: Cloudflare Workers and the wrangler CLI as this repo uses them. Covers deploying the built Vite SPA to Workers static assets, editing wrangler.jsonc (assets.directory, not_found_handling, compatibility_date), wrangler dev/deploy/versions/tail/rollback, Cloudflare API tokens and secrets, CI deploys with cloudflare/wrangler-action, workers.dev and custom domains, cron triggers for a possible future Telegram webhook Worker, and diagnosing a failed Cloudflare deploy. Use whenever a wrangler command, wrangler.jsonc, a CLOUDFLARE_ credential, or a broken deploy of the web app is involved.
---

# Cloudflare (wrangler)

## Scope

This repo uses one Cloudflare product: a Worker that serves static assets. `vite build`
writes `dist/web`, `wrangler deploy` uploads it. There is no `main` script, no D1, KV, R2,
Durable Objects, or Pages. The backend is Supabase and the browser calls it directly, so
nothing runs at the edge. A Telegram webhook or outbox Worker may arrive later:
`references/telegram-worker.md`.

Verified against wrangler **4.136.1** (npm `latest`, published 2026-09-21). The repo pins
`wrangler ^4.136.1` as a devDependency, so `npx wrangler` runs the local copy.

## Commands

```bash
npm run dev                       # vite on :5173, the normal dev loop
npm run build                     # writes dist/web
npx wrangler dev                  # serves dist/web through workerd on :8787
npm run deploy                    # build, then wrangler deploy
npx wrangler deploy --dry-run     # validate config and asset manifest, upload nothing
npx wrangler whoami               # which account the current credentials resolve to
npx wrangler deployments list     # deployment history
npx wrangler deployments status   # what is live now
npx wrangler rollback             # back to the previous version
```

`wrangler dev` is the only local way to see production asset routing (trailing slashes,
404 handling). Vite's dev server has its own rules and will not reproduce them.
<https://developers.cloudflare.com/workers/wrangler/commands/workers/>

Auth locally: `npx wrangler login` (OAuth, browser). Headless or CI: export
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.
<https://developers.cloudflare.com/workers/wrangler/system-environment-variables/>

## wrangler.jsonc

JSONC is the current recommended format. Wrangler 3.91.0+ reads `wrangler.jsonc`,
`wrangler.json`, or `wrangler.toml`; Cloudflare recommends JSONC for new projects and
some newer features are JSON-only. `$schema` gives editors completion and validation.
<https://developers.cloudflare.com/workers/wrangler/configuration/>

Required for any Worker: `name`, `compatibility_date`. `main` is required only when there
is a Worker script; an assets-only Worker omits it.
<https://developers.cloudflare.com/workers/static-assets/>

The `assets` block, with every allowed value (source: `wrangler/config-schema.json`):

| Field | Values | Notes |
| --- | --- | --- |
| `directory` | path | Relative to the config file. `./dist/web` here. |
| `binding` | string | Exposes `env.ASSETS.fetch()`. Pointless without a Worker script. |
| `not_found_handling` | `"none"` (default), `"404-page"`, `"single-page-application"` | See below. |
| `html_handling` | `"auto-trailing-slash"` (default), `"force-trailing-slash"`, `"drop-trailing-slash"`, `"none"` | |
| `run_worker_first` | `false` (default), `true`, or up to 100 glob patterns with `!` negation | Requires a Worker script. |

<https://developers.cloudflare.com/workers/static-assets/binding/>
<https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/>

**Do not switch `not_found_handling` to `"single-page-application"` here.** Routing is
hash based (`#/o/:slug/orders`), so the browser only ever requests `/` from the origin and
the SPA fallback buys nothing. What it does buy is a 200 plus index.html for every missing
file, which turns a broken deploy (a bundle referencing an asset that was not uploaded)
into a page that half loads. `"none"` lets a genuine 404 be a 404.

## Deploying

CI is the canonical path: `.github/workflows/ci.yml` runs typecheck and tests, then on a
push to `main` builds and deploys with `cloudflare/wrangler-action@v4`, which installs its
own wrangler. The repo's devDependency only serves local `npm run deploy`.

Two GitHub secrets are required: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
Create the token from the **Edit Cloudflare Workers** template, which grants Account
Settings read, Workers Scripts edit, Workers KV edit, Workers R2 edit, and zone-level
Workers Routes edit. Scope it to the one account.
<https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/>
<https://developers.cloudflare.com/fundamentals/api/reference/template/>

Gradual deploys, when a Worker script eventually exists and a bad version would matter:

```bash
npx wrangler versions upload                  # new version, no traffic, prints a preview URL
npx wrangler versions upload --preview-alias staging
npx wrangler versions deploy                  # prompts for the traffic split
npx wrangler versions deploy <ID> --percentage 10
```

Only the last 100 uploaded versions can take traffic. Preview URLs are
`<version-or-alias>-<worker>.<subdomain>.workers.dev` and require `preview_urls` enabled.
<https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
<https://developers.cloudflare.com/workers/configuration/previews/>

## Build-time vars are not Cloudflare secrets

| Value | Lives in | Read at |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | GitHub repository *variables*; `.env` locally | `vite build`, inlined into the bundle |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub *secrets* | `wrangler deploy` |
| A Worker runtime secret | Cloudflare, via `wrangler secret put` | Worker request handling. None exist today. |

`npx wrangler secret put NAME` is the wrong tool for anything the SPA needs: an
assets-only Worker executes no code, and every `VITE_` value is public in the bundle
regardless. Secrets become relevant only with the Telegram Worker.

For a Worker that does have secrets: `wrangler secret put|list|delete`, each `put`
creating and deploying a new version; `wrangler versions secret put` to stage one instead;
`wrangler deploy --secrets-file .env.production` for non-interactive CI, which preserves
secrets absent from the file.
<https://developers.cloudflare.com/workers/configuration/secrets/>

Local dev reads `.dev.vars` or `.env`, never both: if a `.dev.vars` exists, `.env` is
ignored entirely. Neither is uploaded by `wrangler deploy`.
<https://developers.cloudflare.com/workers/local-development/environment-variables/>

## URLs and domains

Default URL is `<name>.<account-subdomain>.workers.dev`, controlled by `workers_dev`
(defaults to `true`). A custom domain, which requires the zone to be on Cloudflare and
creates its DNS record and certificate automatically:

```jsonc
"routes": [{ "pattern": "lunch.example.com", "custom_domain": true }]
```

A Custom Domain matches a hostname exactly and takes all its paths. A plain route takes a
wildcard pattern such as `example.com/*` and needs its own DNS record.
<https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
<https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>

## Free plan limits worth knowing

100,000 requests/day, 10 ms CPU per invocation, 128 MB memory, 50 subrequests per
invocation, 100 Workers and 5 cron triggers per account, 20,000 asset files per version,
25 MiB per file, 64 MiB uncompressed Worker size.
<https://developers.cloudflare.com/workers/platform/limits/>

Requests served from static assets are free and unlimited and do not count against the
daily request limit; only Worker script invocations do. That is why this app is
effectively uncapped today, and why adding `run_worker_first` would change the answer.
Exceeding the free tier returns 429 rather than falling back to assets.
<https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>

## Gotchas

- **`VITE_` vars are baked in by `vite build`.** Setting them in the Cloudflare dashboard
  or with `wrangler secret put` does nothing at all. If they are missing when CI builds,
  the deploy still succeeds and ships a bundle whose Supabase client is misconfigured.
- **`wrangler deploy` never builds.** It uploads whatever `dist/web` currently holds. Run
  `npm run deploy`, or build first. A stale `dist/web` deploys silently; an absent one
  fails on the missing `assets.directory`.
- **Asset uploads are content-hashed.** Wrangler sends a manifest of path plus content
  hash and uploads only files Cloudflare does not already have. "0 new files" is a normal
  no-change deploy, not a failure. Vite already fingerprints filenames, so a real code
  change always produces new hashes.
- **Default asset caching is `public, max-age=0, must-revalidate` plus an ETag.** To mark
  Vite's fingerprinted files immutable, add a `_headers` file. It must land inside
  `dist/web`, so it belongs in Vite's `publicDir` (`src/web/public/_headers`), not in the
  build output, which is regenerated and gitignored. Never make index.html immutable.
  <https://developers.cloudflare.com/workers/static-assets/headers/>
- **`compatibility_date` is a pin, not "latest".** Raising it opts into every runtime
  change up to that date on the next deploy. With no Worker code today it is unobservable,
  which is exactly why bumping it reflexively is a habit that bites once code exists.
  Old dates are supported forever.
  <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- **The dashboard loses to the config file.** Disabling the workers.dev route in the UI
  without setting `"workers_dev": false` re-enables it on the next deploy. Same for
  preview URLs and cron triggers.
- **Commenting out `triggers.crons` does not remove crons.** Only `"crons": []` does.
- **`name` identifies the Worker.** Changing it creates a second Worker; the old one keeps
  running and keeps serving its URL.
- **There is nothing to `wrangler tail`.** No Worker script means no invocations and no
  logs; use the dashboard's request analytics instead. Tail becomes useful with the
  Telegram Worker, where `observability.enabled` also matters.

## Troubleshooting

`references/troubleshooting.md` maps deploy failures and post-deploy symptoms to causes.
