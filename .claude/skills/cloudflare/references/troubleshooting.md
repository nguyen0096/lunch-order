# Cloudflare deploy failures

Symptoms first, since that is what you have. Commands assume the repo root.

## First three checks

```bash
npx wrangler whoami                 # right account? token still valid?
npx wrangler deploy --dry-run       # config and manifest, no upload
npx wrangler deployments status     # what is actually live
```

`WRANGLER_LOG=debug npx wrangler deploy` for the full request trace.
<https://developers.cloudflare.com/workers/wrangler/system-environment-variables/>

## Deploy fails

**Authentication error, code 10000.** The token is wrong, expired, revoked, or belongs to
another account; or it lacks Workers Scripts edit. In CI the usual cause is
`CLOUDFLARE_ACCOUNT_ID` pointing at an account the token cannot touch. Recreate from the
Edit Cloudflare Workers template and confirm with `wrangler whoami`.

**The assets directory does not exist.** `dist/web` was never built. `npm run build` first,
or use `npm run deploy`. In CI, check the build step ran and that `build.outDir` in
vite.config.ts still resolves to `dist/web`.

**A workers.dev subdomain must be registered.** First deploy on a fresh account. Register
one in the dashboard under Workers & Pages, or set `"workers_dev": false` and deploy to a
route instead.

**Missing entry-point / `main` required.** The `assets` block is absent or misspelled.
`main` is optional only when `assets.directory` is present and valid.

**Bad config value.** The `$schema` reference catches these in the editor. Enum typos
(`not_found_handling: "spa"`) fail validation at deploy, not at build.

**Too many files, or a file over 25 MiB.** Free and paid both cap at 20,000 files per
version and 25 MiB per file. An accidental source-map or asset dump in `dist/web` is the
usual cause. `.assetsignore` in the assets directory excludes files, gitignore syntax.

## Deploy succeeds, site is wrong

**Blank page, or a Supabase configuration error on every visit.** `VITE_SUPABASE_URL` or
`VITE_SUPABASE_PUBLISHABLE_KEY` was empty when `vite build` ran. They are GitHub
repository variables, not secrets, and not Cloudflare values. Confirm by grepping the
built bundle for the project ref before blaming Cloudflare.

**Old version still served.** Check `wrangler deployments status` against the version you
uploaded, then check the Worker `name` in wrangler.jsonc matches the Worker you are
looking at. `versions upload` alone does not route traffic; it needs `versions deploy`.

**404 on a path that should exist.** Expected. `not_found_handling` is `"none"` and
routing is hash based, so only `/` and real files exist at the origin. A 404 on a
fingerprinted asset means the bundle references a file that was not uploaded: rebuild
clean (`rm -rf dist/web && npm run build`) and redeploy.

**Stale index.html in a browser.** Default asset headers are
`public, max-age=0, must-revalidate` with an ETag, so this should not persist past a hard
reload. If it does, a `_headers` rule is over-caching HTML.

**429s.** Free tier daily limit exceeded on Worker invocations. Static asset requests are
free and unlimited, so on an assets-only Worker this points at a Worker script or a
`run_worker_first` rule that was added.

## Cron did not fire

UTC only. Confirm `triggers.crons` is non-empty in the deployed config, that the Worker
exports a `scheduled` handler, and that the account is under the 5 cron triggers cap.
Schedules are per Worker version, so an old deployment keeps the old schedule.
