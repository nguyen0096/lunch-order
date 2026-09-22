# Screens

What each screen is for, what it contains, and what it does in every state.
A screen that has no defined empty, loading, disabled and error state is not
finished; those states are most of what people actually see on a bad day.

Rules that apply to all of them are in [design-system](design-system.md) and are
not repeated here.

## Sign in

**Job.** Get one person through the door, and be the only place the product has a
personality.

The one screen with nothing to do, so it carries the identity: full-bleed ochre,
today's dish names set large as texture, a single button. Everything after it
stays quiet and functional. Spend the boldness here and nowhere else.

| State | |
| --- | --- |
| default | one button, "Continue with Google" |
| config missing | the `configError` from `supabase.ts`, verbatim, naming the missing variable |
| signed in, no org | "You're signed in as X, but you're not a member of an office yet. Ask for a join code." Not an empty app |

## Board

**Job.** Answer "what am I eating this week" and "how many people am I ordering
for" on one screen. This is the hero and it uses the full width it is given.

**Asymmetric rows.** Your own row shows dish names. Everyone else's shows dots.
You care *what* you are eating; you only need to know *whether* colleagues are,
because that is the headcount the admin defends to the caterer.

```
        Mon 22    Tue 23  │  Wed 24    Thu 25    Fri 26
You     Cơm gà    Phở bò  │  Bún bò      +         +
Tèo       ●         ●     │    ●         ·         ·
Dinh      ●         ·     │    ●         ·         ·
        ────────────────────────────────────────────────
Total     3         2     │    3         0         0
```

`●` ordered · `○` eating, no dish yet · `·` not eating · `│` today

Today is a **column rule**, not a colour change, because ordered already uses the
accent and one hue cannot carry two meanings.

**Week navigation** is `‹ 22–26 Sep ›` with a "This week" reset that appears only
once you have navigated away. One control, not a strip plus a legend plus a label.

### Ordering

| Situation | What happens |
| --- | --- |
| empty cell, menu has one dish | tap, ordered |
| empty cell, menu has several | tap, **a dish is assigned at random**, toast `Cơm gà · tap to change` |
| cell with a dish | tap, dialog opens to pick another or Surprise me |
| filled cell | clear it from the dialog |

Randomising on the first tap is the default, not a fallback: on most days nobody
minds which of three similar dishes arrives, and the people who do mind get a
dialog one tap away. "Eating, dish not chosen" therefore never arises from a tap.
It survives only for a standing order materialised before a menu existed, which is
the one case where the system genuinely cannot guess.

Cells are **optimistic**: they fill immediately and revert with the database's own
sentence if refused, e.g. `ordering for 23/09 closed at 21:00 22/09`.

### Passing a meal

An action on the cell, not a destination. Your own cell offers "Pass to…" with a
combobox of colleagues you type to filter. An incoming offer appears on the cell
it concerns, with Accept and Decline inline.

Admins record somebody else's swap the same way, on any cell. The grid already
shows every `person × day × dish`, so there is no dropdown.

The window is the **open billing week**, not today onward. People remember on
Thursday that Tuesday's lunch went to somebody else, and the database permits it
until the period closes.

| State | |
| --- | --- |
| loading | skeleton shaped like the grid |
| no menu that day | the cell is inert and says so on tap |
| cutoff passed | cell disabled, reason is the database's sentence |
| no members but you | the board still renders; an office of one is not an error |

## Bill

**Job.** Answer "what do I owe and how do I pay it" in one glance.

Large amount. The `payment_ref` prominent, because it is the thing that gets
mistyped and a wrong memo means an unmatched payment. VietQR beneath it. Past
weeks collapsed below.

| State | |
| --- | --- |
| nothing owed | "Nothing owed yet. This week closes Monday." |
| unpaid | amount, reference, QR |
| partial | amount remaining, and what was received |
| paid | receipt, quiet, no call to action |

## Menu (admin)

**Job.** Turn the caterer's chat message into a published menu without retyping it.

Paste the message into one textarea, parse, then an **editable table** of dish and
price with the parser's uncertainty shown per row. It should feel like checking a
list, not filling a form.

Two parse paths: the offline regex parser, which is free, instant and usually
right, and "Read with AI", which calls `parse-assist`. Nothing is written until
Publish, and a human sets every price that reaches a bill.

Publishing is the highest-consequence action in the app, so it confirms, naming
the date and how many people it will notify.

| State | |
| --- | --- |
| no menu for the date | empty editor, paste prompt |
| draft | editable, Publish enabled once a dish is available |
| published | editable with a warning that orders exist |
| locked | read only, with the reason: orders have gone to the caterer |
| parse found nothing | the raw lines, offered as manual rows. Never a dead end |

## People (admin)

**Job.** Get somebody in, and notice somebody who should not be.

The join code leads, large, with copy, QR, when it was last set, and Rotate.
Email invitations are demoted to a secondary option, because most members join
from Telegram and have no email address.

Recent joins are listed beneath the code with names and times. That is the safety
mechanism: a leaked code is noticed, not prevented. See
[join-codes](../explanation/join-codes.md).

Member list with roles below. **Every disabled control states why**: you cannot
change your own role, and you cannot change an owner's. A row of grey controls
with no explanation is what made this screen look broken while it was working.

| State | |
| --- | --- |
| only you | the code, and "Share this to add your first colleague" |
| no code set | "No join code yet" with Create |
| role changed | toast, "Now an admin" |

## Settings (behind the avatar)

**Job.** Things set once and forgotten.

Standing days as a row of weekday toggles, the Telegram connection with its deep
link or its connected state, display name, sign out. Not a tab: it would compete
with the two things people do weekly, and lose.

## Join (invitation link)

**Job.** One decision, taken immediately.

Reached from an emailed invitation. Names the org, states the role, one button.
Errors come from `accept_invitation` verbatim: expired, already used, addressed to
a different account, or an account with no email address at all.
