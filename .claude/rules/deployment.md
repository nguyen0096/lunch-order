# Deployment: pushing to production safely

A push to `main` is a production deploy. Two systems act on it independently:

- **The Supabase GitHub integration** applies new migrations.
- **`.github/workflows/deploy.yml`** deploys the web app and the Edge Functions
  once CI passes, then cuts a release.

CI never runs migrations, and a failed migration does not stop the deploy. So
the two can land in either order.

## Rules

- **Code that needs a new migration ships after it.** Push the database commit
  alone, confirm in production that it applied (the migration is listed and
  the new functions or columns exist), then push the client commit.
- **Removing something the live app uses ships last.** Stop using it in code
  first, deploy that, and only then drop it. The web app has no auto-reload,
  so wait until open tabs have refreshed (the owner picks the time).
- **Migration versions sort after everything already applied.** Check the
  newest version on `main` and on other open branches before naming one.
- **After each push,** confirm CI, Deploy and the release succeeded.
