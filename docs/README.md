# Documentation

Organised on [Diátaxis](https://diataxis.fr): each page serves one need, and
mixing them is what makes documentation that nobody finds anything in.

| | Answers | Read when |
| --- | --- | --- |
| [how-to](how-to/) | "how do I do X" | you have a job to finish |
| [reference](reference/) | "what exactly is X" | you are building and need the rules |
| [explanation](explanation/) | "why is X like that" | you are about to change a decision |

## How-to

- [Set up a deployment](how-to/set-up-a-deployment.md): Worker, secrets, Vault, GitHub, Telegram, once per environment
- [Deploy the Edge Functions](how-to/deploy-edge-functions.md)
- [Test by hand](how-to/test-by-hand.md): seed a mock office and move the clock
- [Rotate the Telegram join code](how-to/rotate-the-join-code.md)
- [Set up where the money goes](how-to/set-up-payment.md)
- [Connect SePay so bank transfers record themselves](how-to/connect-sepay.md)
- [Refresh the bank app list](how-to/refresh-bank-app-list.md): the phone's "Open your bank app" list, and what depends on dl.vietqr.io
- [Lọc giao dịch SePay theo từ khóa](how-to/loc-giao-dich-sepay.md): in Vietnamese, because its reader does this in SePay's Vietnamese interface

## Reference

- [Secrets](reference/secrets.md): every secret and deploy setting, and where each lives
- [Database](reference/database.md): migrations, tests, and the invariants no change may break
- [Design system](reference/design-system.md): tokens, type, the six non-negotiables
- [Screens](reference/screens.md): what each screen is for, contains, and does in every state

## Explanation

- [Where it runs](explanation/where-it-runs.md): why a static bundle on Cloudflare talks straight to Postgres
- [Menu parsing](explanation/menu-parsing.md): why two parsers, and what keeps the AI one safe
- [Advisor findings](explanation/advisor-findings.md): which Supabase advisor warnings are deliberate
- [Information architecture](explanation/information-architecture.md): why the app is two tabs
- [Join codes](explanation/join-codes.md): why the code is permanent and what actually protects it

[Decisions](decisions.md) records each choice and its reasons.
[Backlog](backlog.md) holds the big pieces not started yet.
