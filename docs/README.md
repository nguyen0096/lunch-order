# Documentation

Organised on [Diátaxis](https://diataxis.fr): each page serves one need, and
mixing them is what makes documentation that nobody finds anything in.

| | Answers | Read when |
| --- | --- | --- |
| [how-to](how-to/) | "how do I do X" | you have a job to finish |
| [reference](reference/) | "what exactly is X" | you are building and need the rules |
| [explanation](explanation/) | "why is X like that" | you are about to change a decision |

## How-to

- [Deploy the Edge Functions](how-to/deploy-edge-functions.md)
- [Rotate the Telegram join code](how-to/rotate-the-join-code.md)
- [Set up where the money goes](how-to/set-up-payment.md)
- [Lọc giao dịch SePay theo từ khóa](how-to/loc-giao-dich-sepay.md) — in Vietnamese, because its reader does this in SePay's Vietnamese interface

## Reference

- [Design system](reference/design-system.md) — tokens, type, the six non-negotiables
- [Screens](reference/screens.md) — what each screen is for, contains, and does in every state

## Explanation

- [Information architecture](explanation/information-architecture.md) — why the app is two tabs
- [Join codes](explanation/join-codes.md) — why the code is permanent and what actually protects it

[Backlog](backlog.md) holds the big pieces not started yet.

Operational setup (secrets, deploys, the database) lives in the top-level
[README](../README.md), because it is the first thing a new person needs and
splitting it across two files helps nobody.
