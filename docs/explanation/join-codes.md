# Join codes

Why one permanent code per org, and what actually protects it.

## The shape

`organizations.telegram_join_code`: one nullable column, unique across orgs,
constrained to `^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12}$`. No expiry, no usage
limit, no record of which code a member used.

Somebody sends it to the bot, is asked their name, and `public.join_with_code`
creates an anonymous auth user, a profile, a membership and a Telegram link in
one transaction. They never need an email address.

## Why permanent

An expiring code fails in the worst possible way for this app: a new joiner says
"it doesn't work" and the admin has no idea why, because nothing was broken and
nothing was announced. That is a worse day than the leak the expiry was
protecting against.

A single-use code per person is the `invitations` table, which already exists and
is keyed on an email address. Telegram members do not have one. Building a
parallel single-use mechanism means rebuilding invitations for people who cannot
receive them.

So: permanent, and cheap to rotate when there is a reason.

## What a leaked code actually costs

Worth stating precisely, because the intuitive answer understates it.

Somebody with the code joins as a `member`, never as an admin: `join_with_code`
hardcodes the role, so a code shared in a group chat cannot promote anyone. They
see the shared order board, which is names and who is eating, and they can order
lunches billed to themselves.

The real cost is the **headcount**. An admin gives the caterer a number. A
stranger in that number means food bought and paid for by the office that nobody
reimburses. Small per meal, repeatable, and invisible in a totals row.

## Why detection rather than prevention

Given the code is shared in a group chat, it will eventually reach someone it
should not. Designing as though it will not is wishful.

So the People screen makes a stranger **visible** instead: the code shows when it
was last set, and recent joins are listed beneath it with names and times. An
admin who opens that screen sees an unfamiliar name. That is the mechanism, and
it works precisely because the admin already goes there to manage people.

The remedy is already built. Deactivating a membership sets `status = 'inactive'`,
`private.my_org_ids()` filters on exactly that, and every policy stops matching on
their next request.

## If this org ever grows

The current model suits one office where everyone knows everyone by name, which is
what makes detection work. It stops working at the scale where an admin no longer
recognises the member list.

At that point the answer is admin approval on join, not expiry: `memberships`
already carries a `status`, so a `pending` state and an approve action reuse
machinery that exists rather than adding a parallel one. Deliberately not built
now, because it costs every joiner a wait for a problem this office does not have.
