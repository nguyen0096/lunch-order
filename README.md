# Lunch Order

Office lunch ordering: a web app for the menu and the bill, a Telegram bot for the nudging.

[![CI](https://github.com/nguyen0096/lunch-order/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nguyen0096/lunch-order/actions/workflows/ci.yml?query=branch%3Amain)
[![Deploy](https://github.com/nguyen0096/lunch-order/actions/workflows/deploy.yml/badge.svg)](https://github.com/nguyen0096/lunch-order/actions/workflows/deploy.yml)
[![Release](https://img.shields.io/github/v/release/nguyen0096/lunch-order?sort=date&display_name=tag)](https://github.com/nguyen0096/lunch-order/releases/latest)

An admin publishes the day's menu, members tick what they want, and each week's
bill is computed automatically, with bank transfers matched to the person who
sent them. Built for Persefoni's Vietnam office first, which is why VietQR and
Vietnamese menu parsing come first, but every table is multi-tenant from the
first migration.

Live at <https://lunch-order.nexus-9c9.workers.dev>.

## Features

- **Daily menus** pasted from the caterer's message and read by a regex parser
  or, optionally, an LLM, with a human setting every price.
- **Ordering** on a weekly board, with standing orders and a per-office cutoff
  the database enforces.
- **Weekly bills** with a VietQR code and a personal transfer reference.
- **Payments that record themselves** through a SePay bank webhook, with
  unmatched money left for an admin to assign and every correction on the record.
- **A Telegram bot** that joins members by code, takes orders and sends reminders.
- **Tenant isolation** by row-level security, proven by a SQL test.

## Stack

React and Vite, served as static assets from Cloudflare Workers. Postgres on
Supabase with RLS as the security boundary, pg_cron for scheduling, and Deno
Edge Functions for the bot, the payment webhook and the AI menu reader.

## Quick start

Needs Node 22.

```bash
npm install
cp .env.example .env      # the Supabase URL and publishable key
npm run dev
npm run typecheck && npm test
```

A push to `main` that passes CI deploys the app and the Edge Functions and
publishes a release. There is no manual step.

## Documentation

Everything else is in [docs/](docs/README.md):

- [Set up a deployment](docs/how-to/set-up-a-deployment.md) and
  [Secrets](docs/reference/secrets.md)
- [Database](docs/reference/database.md), including the invariants no change may break
- [Screens](docs/reference/screens.md) and [Design system](docs/reference/design-system.md)
- [Decisions](docs/decisions.md), for why things are the way they are
