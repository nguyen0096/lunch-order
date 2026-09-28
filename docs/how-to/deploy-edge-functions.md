# Deploy the Edge Functions

CI deploys them for you. This page is for the cases where it cannot: a function
you are iterating on, a rollback, or a CI outage.

There used to be a `scripts/deploy-functions.sh` that did this. It is gone. It
carried per-function flags that CI could not see, so the two paths could disagree
about whether the Telegram webhook verified JWTs, and a wrong answer there
rejects every update Telegram sends while the logs say the deploy succeeded.
Those settings now live in `supabase/config.toml`, which both paths read.

## Normally: merge to main

```bash
git push origin main
```

`.github/workflows/ci.yml` runs typecheck and tests. When it passes on `main`,
`.github/workflows/deploy.yml` deploys all four functions (`telegram`,
`outbox-drain`, `parse-assist`, `sepay`) with `supabase functions deploy`, then
registers Telegram's webhook on `telegram`. Nothing else is required, and this
is the path that should be used.

## Deploying by hand

You need a personal access token from
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

```bash
export SUPABASE_ACCESS_TOKEN='<your token>'

npx supabase functions deploy --project-ref wvtbstticnactealupph
```

That deploys every function in `supabase/functions/`. To deploy one:

```bash
npx supabase functions deploy telegram --project-ref wvtbstticnactealupph
```

Do **not** pass `--no-verify-jwt` or any other per-function flag. Those belong in
`supabase/config.toml` so that a hand deploy and a CI deploy produce the same
thing. If you find yourself needing a flag, the fix is to add it to that file.

## Confirming what is actually running

```bash
npx supabase functions list --project-ref wvtbstticnactealupph
```

Check `verify_jwt` matches `supabase/config.toml`: `false` for `telegram` and
`sepay`, `true` for `outbox-drain` and `parse-assist`. A mismatch means something
deployed outside the normal path.

A hand deploy does not register the webhook. It does not need to unless
`supabase/functions/telegram/allowed_updates.json` changed; if it did, use the
emergency command in [Set up a deployment](set-up-a-deployment.md), step 7. For `sepay` it is the difference between
working and silently dropping money: with the gate on, SePay's deliveries are
refused before the function's per-office API key check runs, and after its
retries give up nothing records the transfer.

## Rolling back

There is no version history for Edge Functions. Roll the code back and deploy
again:

```bash
git revert <sha>
git push origin main
```

## When a function is deployed but nothing happens

Work down this list rather than guessing, because several of these look
identical from the outside.

| Symptom | Cause |
| --- | --- |
| Telegram silent, `getWebhookInfo` shows `401 Unauthorized` | `TELEGRAM_WEBHOOK_SECRET` differs between Supabase and the value given to `setWebhook`. The deploy refuses to register a mismatched one, so look for a hand registration or a Supabase secret changed since |
| Telegram silent, `getWebhookInfo` clean | `verify_jwt` is true for `telegram`; check `config.toml` deployed |
| Bot added to a group but posts no chat ID | `getWebhookInfo` lists `allowed_updates` without `my_chat_member`. The deploy's `register-webhook` job was skipped (no Telegram GitHub secrets) or failed; fix that and rerun it, or see [Set up a deployment](set-up-a-deployment.md), step 7 |
| Outbox never sends, cron says succeeded | `pg_net` is asynchronous, so the cron job never sees the response. Look in `net._http_response`, not `cron.job_run_details` |
| `404 NOT_FOUND: Requested function was not found` in `net._http_response` | the function is not deployed |

Secrets take effect immediately without a redeploy, but a warm isolate can hold
an old value for up to a few minutes. A failure that clears on its own after one
retry was a stale isolate, not a wrong secret.

## Related

- [Secrets](../reference/secrets.md) for what each function needs and where it lives
- [Rotate the Telegram join code](rotate-the-join-code.md)
