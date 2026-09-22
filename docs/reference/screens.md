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
the dish names set large, a single button. Everything after it stays quiet and
functional. Spend the boldness here and nowhere else.

Two compositions, not one stretched, which is the rule the shell follows too. On
a monitor the names become the second column, ruled like a menu card and running
off the bottom edge, while the wordmark, the sentence and the button hold the
left. On a phone the same two parts stack, names beneath the button. The names
are never behind the words: a wash under a headline makes both harder to read.

Their strength is measured rather than eyeballed. `accent-fg` on `accent` reaches
4.66:1 in light and 8.42:1 in dark at full opacity, so a single opacity would
read as two different things; the pairs in the component put both schemes near
1.9:1 stacked and 2.5:1 beside. Texture in both, and legibly texture rather than
something that looks broken.

| State | |
| --- | --- |
| default | one button, "Continue with Google" |
| config missing | the `configError` from `supabase.ts`, verbatim, naming the missing variable |
| signed in, no org | "You're signed in as X, but you're not a member of an office yet. Ask for a join code." Not an empty app |

## Board

**Job.** Answer "what am I eating this week" and "how many people am I ordering
for" on one screen. This is the hero and it uses the full width it is given.

**Asymmetric rows.** Your own row shows dish names, and the note under them.
Everyone else's shows a fill. You care *what* you are eating; you only need to
know *whether* colleagues are, because that is the headcount the admin defends to
the caterer.

```
          Mon 22    Tue 23    Wed 24     Thu 25   Fri 26
          ▒▒▒▒▒▒    ▒▒▒▒▒▒    Today
                              ══════
You       ▓Cơm gà▓  ▓Phở bò▓  ▓Bún bò▓   [ + ]   [ + ][⚄]
          ▓ít cơm▓
Tèo       ▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓  ▒to Dinh▒  ┌────┐  ┌────┐
Dinh      ▓▓▓▓▓▓▓▓  ┌──────┐  ▓▓▓▓▓▓▓▓   └────┘  └────┘
          ───────────────────────────────────────────────
Total     3         2         3           0       0

Wednesday 24 September                    Closes 21:00 23/09
Cơm gà  45.000 ₫    Bún bò  50.000 ₫     Phở bò  40.000 ₫
```

`▓` ordered · `░` eating, no dish yet · `▒` recessive · `┌┐` empty, still a target

**Which days you can act on** is the first question the grid answers, so a day
whose window has shut recedes into `surface-sunken`, head to total. Today is the
word `Today` under the date. An accent rule down the column edge used to mark
today and it read as a divider between two days rather than a property of one;
the accent belongs to *ordered*.

**The menu panel** under the grid names one day's dishes with prices and when it
closes, so nobody has to tap a cell to find out what is on offer. It opens on the
next day you can still order for, and a tap on any column head moves it.

**Week navigation** is `‹ 22–26 Sept ›` with a "This week" reset that appears only
once you have navigated away. One control, not a strip plus a legend plus a label.

### Ordering

| Situation | What happens |
| --- | --- |
| empty cell, menu has one dish | tap `+`, ordered. No dialog, there is nothing to choose |
| empty cell, menu has several | the dice orders one at random, toast `Ordered Cơm gà · tap to change`; `+` opens the chooser |
| cell with a dish | tap, dialog opens to pick another or Surprise me |
| filled cell | clear it from the dialog |
| a note | `ít cơm`, `không trứng`: a field under the dish, up to 120 characters, saved against the dish and shown under it on your row |

The dice is offered only where there is something to randomise. Randomising is a
first-class choice, not a fallback: on most days nobody minds which of three
similar dishes arrives, and the people who do mind take the `+` instead. "Eating,
dish not chosen" therefore never arises from a tap. It survives only for a
standing order materialised before a menu existed, which is the one case where the
system genuinely cannot guess.

An admin opening a colleague's cell can read that colleague's note, because the
admin is the person who reads the list down the phone to the caterer.

Cells are **optimistic**: they fill immediately and revert with the database's own
sentence if refused, e.g. `ordering for 23/09 closed at 21:00 22/09`.

### Passing a meal

**You pass a meal by tapping the cell of the person you are giving it to.** The
board is already a grid of people; sending somebody to a dropdown to find a
colleague asks them to re-enter what the screen is showing them.

A colleague's cell opens a small sheet, whether or not they are eating, because "I
am out, you have mine" is usually said to somebody who was not eating anyway:

| Control | Who sees it |
| --- | --- |
| `Give Tèo my Bún bò` | everyone. It carries `passOnReason`'s sentence when there is nothing to give |
| `Pass Tèo's Cơm gà to someone` | admins, when that person has a meal. The one place a recipient is still picked from a list |
| `Withdraw` | whoever made the offer, and admins, when one is pending |

An incoming offer appears on your own cell, with Accept and Decline inline. A
pending offer is legible on the board as the recipient's name on the cell, so an
admin has a reason to open it.

Sentences, not icons. A cell is a person and a day, so a tap could mean give or
take, and that is a difference of grammar rather than appearance: two arrows would
need a legend, and a board that needs a legend has already lost.

The window is the **open billing week**, not today onward. People remember on
Thursday that Tuesday's lunch went to somebody else, and the database permits it
until the period closes.

| State | |
| --- | --- |
| loading | skeleton shaped like the grid |
| no menu that day | the cell is inert and says so on tap; the panel says it too |
| cutoff passed | the column recedes, the cell carries the database's sentence |
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

The **theme** lives in the account menu itself rather than on the settings page,
beside sign out, because it is the one preference somebody changes on a whim and
wants to see take effect in the same breath. Three states, `System / Light /
Dark`: a two-state switch cannot say "follow the machine", so the first thing it
does is quietly stop following it. The choice is kept in `localStorage` and
applied to the document element before first paint.

## Join (invitation link)

**Job.** One decision, taken immediately.

Reached from an emailed invitation. Names the org, states the role, one button.
Errors come from `accept_invitation` verbatim: expired, already used, addressed to
a different account, or an account with no email address at all.
