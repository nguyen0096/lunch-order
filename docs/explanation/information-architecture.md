# Information architecture

Why the web app is two tabs, and why it used to be five.

## What changed underneath it

The first version was built web-first, on the assumption in the old stylesheet:
*"this is opened from a pinned chat link, on a phone, daily."* Five tabs made
sense for an app that was the only way in.

Telegram is now the only way in for most people. They order, cancel and check
what they owe without opening a browser, and they never had an email address to
sign in with. That leaves the web app doing a different job: the desktop surface
where an admin publishes a menu, reads the week, and settles the bill, plus a
place for anyone to see the board on a bigger screen.

The navigation never caught up, which is why it felt heavy. It was carrying a
full member experience that its members no longer used.

## The shape now

```
Board        the week, everyone, tap to order
Bill         what you owe, how to pay
─────────────────────────────────
Menu         admin
People       admin
                          [avatar ▾]  standing days
                                      telegram
                                      display name
```

**Two tabs for a member**, because there are two recurring questions: what am I
eating, and what do I owe. Everything else is done once.

**Settings behind the avatar**, because standing days, the Telegram link and your
display name are set once and forgotten. A permanent tab for them competes with
the two things people do weekly, and loses.

**Admin tools are visually separate**, not interleaved. An admin is a member who
also has chores; the chores should not crowd the daily act.

## Two screens that stopped existing

**Transfers** was a destination with its own list of your meals, a form, and a
dropdown of colleagues. But the board is already a grid of exactly the thing you
are looking for. Making someone leave it, find their meal again in a different
list, and pick a day is asking them to re-enter what the screen in front of them
is already showing. Passing a meal is now an action on the cell, and an incoming
offer appears on the cell too.

The admin version was worse: one `<select>` containing every `person — date —
dish` in the org, flattened. The grid replaces it entirely.

**Preferences** mixed money with setup. Splitting it gave Bill a clear job and a
clear empty state, and sent the rest behind the avatar.

## Naming

**Bill**, not "Me". A label naming the *user* rather than the job answers nothing:
what about me? "Bill" is a noun people already use for this, it can be checked in
one glance, and it has an obvious empty state: *"Nothing owed yet. This week
closes Monday."*

The risk is that "Board" and "Bill" are both short B-words and may blur. If they
do in practice, "What I owe" is the unambiguous replacement, at the cost of being
a phrase.

## What did not change

Authorization. Roles, RLS and the triggers are untouched by any of this: the
database refuses what it refuses regardless of which tab a control sits on.
Hiding a tab is a courtesy to the user, never a security boundary. See
[design-system](../reference/design-system.md) for why every hidden control still
states its reason when it is merely disabled.

## Creating an office refetches before it routes

The obvious order is wrong here. `App` resolves a slug it does not recognise by
sending you to your first office, which is what stops a stale bookmark rendering
an empty app. A newly created office is a slug `me` has never heard of, so
routing to it and refetching afterwards bounces the founder straight back to
where they started, having apparently created nothing.

So `reload` is awaited and the redirect happens after it. The test that holds
this mounts the app with a deliberately slow `fetchMe`, because an
instantly-resolving one hides the race entirely: the first version of that test
passed against the broken code.
