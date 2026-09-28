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
   as keywords. Do not type a number here: the six-digit NAPAS BIN behind each
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
`jsonb` with no database-side check, so a typo here is not rejected. It just
produces a bill with no QR on it.

## Telling the bot where to post

Same screen, **Telegram group chat**. The bot does not fill this in by itself:

1. Add the bot to the office's group. As it arrives it posts one message there:
   "This group's chat ID is `-1001234567890`. An admin can paste it in the lunch
   app under Settings > Telegram group chat." The ID is formatted as code, so a
   tap copies it.
2. Paste the ID into **Chat id** and press **Save**.

The message names no office, because anybody can add the bot to any group. The
bot says nothing when it is removed.

If the group is later upgraded to a supergroup, Telegram gives it a new ID. The
bot posts the new one in the supergroup and moves every office that posted to
the old ID, and any of its messages not yet sent, to the new one, so nothing
needs re-pasting. Pasting it by hand is still possible if the bot missed the
upgrade.

The webhook must receive `my_chat_member` for the bot to hear about being
added reliably; see step 7 of [Set up a deployment](set-up-a-deployment.md).

While `telegram_group_chat_id` is null the bot has nowhere to announce a
published menu, which is why `notification_outbox` stays empty.

## Checking it worked

```sql
select payment_config, telegram_group_chat_id
  from public.organizations where slug = 'test-office';
```

Then open **Bill**. A statement with an amount should now carry a QR above the
payment reference.
