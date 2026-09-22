#!/usr/bin/env bash
# Description: Deploy Edge Functions from the repo, so what runs is what is committed.
#
# Deploying by pasting file contents into an API call lets the running function
# drift from the repo silently. Always go through this.
set -euo pipefail
PROJECT_REF="${PROJECT_REF:-wvtbstticnactealupph}"
cd "$(dirname "$0")/.."

# The default list is expanded rather than interpolated, so each name is its own
# argument. "${@:-a b c}" would deploy a single function called "a b c".
FUNCTIONS=("$@")
if [ ${#FUNCTIONS[@]} -eq 0 ]; then
  FUNCTIONS=(parse-assist telegram outbox-drain)
fi

for fn in "${FUNCTIONS[@]}"; do
  echo "deploying $fn"
  # Telegram authenticates itself with the X-Telegram-Bot-Api-Secret-Token
  # header, not a project JWT, so the platform gate would reject every update
  # before the function's own check ran. outbox-drain keeps the gate on: pg_net
  # sends the publishable key, and its shared secret is the real authorization.
  case "$fn" in
    telegram) verify=(--no-verify-jwt) ;;
    *)        verify=() ;;
  esac
  npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" ${verify[@]+"${verify[@]}"}
done
