# Set up where the money goes

Do this once, before the first bill. Until it is done `payment_config` is `{}`,
every bill shows the amount and the reference but no QR, and the Telegram bot's
`/bill` sends no QR either.

You need to be an **admin or owner** of the office. The database declines the
write for anyone else, and the screen says so rather than reporting a save that
did not happen.

## From the app

Avatar → **Settings** → *Your office* → **Where the money goes**.

1. Pick the bank. It is a searchable list of 36 Vietnamese banks; type the short
   name or the old one, since banks that have rebranded carry their former names
   as keywords. Do not type a number here — the six-digit NAPAS BIN behind each
   entry is what the QR encodes, and a wrong one produces a code that scans
   cleanly and pays somebody else.
2. Enter the account number and the account holder's name. The name is shown to
   the payer before they confirm, which is how a wrong account gets caught.
3. The note is optional and appears under the QR. "Cash is fine too, ask Chi" is
   the kind of thing that belongs there.
4. Save. The confirmation line repeats the account back in plain words.

The same account then serves both surfaces: the web bill builds its QR in the
browser, and the bot builds an `img.vietqr.io` link. They read the same row.

## From SQL

```sql
update public.organizations
   set payment_config = jsonb_build_object(
         'vietqr', jsonb_build_object(
           'bankBin',       '970436',
           'accountNumber', '0123456789',
           'accountName',   'NGUYEN VAN A'),
         'note', null)
 where slug = 'test-office';
```

The shape is defined in `src/shared/payment.ts` and nowhere else. The column is
`jsonb` with no database-side check, so a typo here is not rejected — it just
produces a bill with no QR on it.

## Telling the bot where to post

Same screen, **Where the bot posts**. The bot normally fills this in itself from
the first message it sees in the group, so the usual answer is to add the bot to
the group and send anything. The field is there for an admin who already knows
the chat id and does not want to wait.

While `telegram_group_chat_id` is null the bot has nowhere to announce a
published menu, which is why `notification_outbox` stays empty.

## Checking it worked

```sql
select payment_config, telegram_group_chat_id
  from public.organizations where slug = 'test-office';
```

Then open **Bill**. A statement with an amount should now carry a QR above the
payment reference.
