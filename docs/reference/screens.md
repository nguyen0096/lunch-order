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
| signed in, no office | join with a colleague's code, and below a rule, create the office yourself. Joining leads because most people are joining somebody else's office, not founding one |
| signed in, no office, founding switched off | the join code alone. `app_settings.office_creation` is a row the database holds and `create_organization` refuses on, so the second door is not hidden, it is shut: every place that offered it (this screen, the account menu, the office switcher) reads the same switch |

## Switching office

**Job.** Cross between two offices without leaving the page you were reading.

The office name is the control, and **only above one office** — somebody in a
single office keeps a plain heading rather than gaining a menu that does
nothing, which is almost everybody.

The page carries over where it still means something: two bills compare without
a detour back to the board. The two admin chores do not, because a role does not
follow you: a member switching from an office they administer lands on the
board, not on a page explaining that the page is not for them.

Creating an office lives here for somebody who already has one, and on the
sign-in screen for somebody who belongs nowhere. It has one home at a time, not
both.

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

**Which days you can act on** is the first question the grid answers, and the
column head answers it in words. A day carries its stage under the date --
`No menu`, `Closed`, `Cooking`, `Served`, `Cancelled` -- and `Today` beside it
when both hold, which by mid-afternoon they usually do. An open day says
nothing, because there is nothing to say.

This used to be a tint: the whole column receded into `surface-sunken`. One
grey covered a day with no menu, a day past its cutoff and a day lunch was
called off on, so the commonest reading of it -- these are the days with a menu
-- was not one of the three things it meant. Colour here means one thing now,
and that is *ordered*.

Every word is the same for everybody. This board is where an admin orders
their own lunch, so the clock binds them exactly as it binds a member, and
there is nothing here an admin sees that a member does not. See
[the five stages](#the-five-stages-of-a-day).

**The menu panel** under the grid names one day's dishes with prices and when it
closes, so nobody has to tap a cell to find out what is on offer. It opens on the
next day you can still order for, and a tap on any column head moves it.

**Week navigation** is `‹ 22–26 Sept ›` with a "This week" reset that appears only
once you have navigated away. One control, not a strip plus a legend plus a label.

Under the range, quieter, is `Week 39`. The range is where you are; the number
is how the rest of the system names the same week, and a person who has only
ever seen it in the middle of a statement's payment reference has had nowhere
to look it up. It is the ISO week of the middle of the range, so an office
whose billing week starts on a Sunday still gets the week its lunches are in.

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
| `Give Tèo my Bún bò` | everyone, and it is the only control on a colleague's cell. It carries `passOnReason`'s sentence when there is nothing to give |
| `Withdraw` | whoever made the offer, on their own cell, when one is pending |

There is no admin row, here or anywhere else on this screen. An admin orders
their own lunch from this board exactly as a member does, and the one control
that was theirs -- `Pass Tèo's Cơm gà to someone`, a recipient picked from a
list -- is gone with the rest. Recording a swap between two other people is a
correction of what was written down rather than an arrangement between two
people, and it has no screen yet: see
[the backlog](../backlog.md#a-board-for-adjusting-what-was-recorded).

An incoming offer appears on your own cell, with Accept and Decline inline. A
pending offer is legible on the board as the recipient's name on the cell, so
nobody offers a meal that is already spoken for.

Sentences, not icons. A cell is a person and a day, so a tap could mean give or
take, and that is a difference of grammar rather than appearance: two arrows would
need a legend, and a board that needs a legend has already lost.

The window for a member ends when the day does, at the office's end of day.
People remember on Thursday that Tuesday's lunch went to somebody else, but by
Thursday Tuesday's lunch has been eaten, and recording it then is bookkeeping
rather than an arrangement. The database keeps an admin's window open for the
whole billing week, and nothing on this screen spends it.

| State | |
| --- | --- |
| loading | skeleton shaped like the grid |
| no menu that day | the cell is inert and says so on tap; the panel says it too |
| cutoff passed | the column recedes, the cell carries the database's sentence |
| no members but you | the board still renders; an office of one is not an error |

## The five stages of a day

Every screen that shows a day shows its stage, and they all derive it the same
way, from `dayStage` in `shared/gating.ts` mirroring `private.day_stage`.

| Stage | When | A member can | An admin can |
| --- | --- | --- | --- |
| `No menu` | nothing published | nothing | publish one, for a past day too |
| `Open` | published, cutoff ahead | order, change, cancel, pass a meal | the same |
| `Closed` | the cutoff passed | pass a meal | correct the record, never on the Board |
| `Cooking` | the office's start of day | pass a meal | correct the record |
| `Served` | the office's end of day | nothing | correct the record, record a pass |
| `Cancelled` | lunch is off | nothing | nothing; no status leaves cancelled |

`Cooking` and `Served` come from `business_day_starts_at` and
`business_day_ends_at` on the office, 08:30 and 17:30 by default. They are
computed on every read rather than stored: a stored stage would need the hourly
tick to advance it, and an hour is long enough to pass on a meal already eaten.

## Bill

**Job.** Answer "what do I owe and how do I pay it" in one glance.

**It leads with an account, not a week.** Everything billed minus everything
received, across every week, is one number and it is the only one anybody can
act on. Leading with a week meant paying that week: somebody three weeks behind
read the newest figure and paid it. The weeks are still here, below, as the
history behind that number rather than as a list of things separately payable.

The figure is always drawn, including the zero, and always in the same place:
the label says whether there is anything to do, the figure says how much you
have got. One line under it, and it holds the arithmetic behind the figure and
nothing else -- `405.000 ₫ billed, 225.000 ₫ received.` A meal count answered a
different question, which the weeks below already answer, and with nothing
received there is no arithmetic, so no line: "0 ₫ received" is not information,
it is an accusation.

**One transfer block, one QR.** The code and the details beside it are the same
transfer read two ways, for the two ways people pay: scan, or type it into a
banking app by hand. Every copyable detail carries an icon copy button, and
there is no field for editing the amount -- the amount is typed in the bank app
where the transfer is actually confirmed, and a second amount box here was one
more thing to get wrong.

| Row | Shown |
| --- | --- |
| Amount | only when something is owed. Copies as plain digits: `45.000 ₫` in an amount field fails, and on VND a grouping dot read as a decimal point turns 45.000 into forty-five dong |
| Reference | always |
| Account | always, with the account holder's name under it |
| Bank | always |

The reference is the part that gets mistyped, and getting it wrong is not
something anybody can put right afterwards: a transfer whose memo omits it
never reaches this app at all, so it is not unmatched money waiting for an
admin, it is money nobody here can see. It is **the same reference every
week** -- it carries no week number, so it can be saved in a banking app.

**A negative balance is credit, not an error.** It is what a top-up looks like
once it is on the books, and the screen says so. The block stays: somebody in
credit is exactly the person who tops up again, and the note says what happens
to anything above what is owed.

| State | |
| --- | --- |
| nothing billed | "Nothing to pay", 0, and when the open week closes |
| owing | the balance, the Amount row, the reference, the QR carrying both |
| in credit | what is in hand, and that it comes off the next lunches |
| settled | "Nothing to pay", what was billed and paid. No call to action |

A meal the caterer has not priced is in no total, so wherever a total appears
the screen says how many are waiting and that they arrive on a later bill. A
*failure to find that out* is said too: a total that leaves meals out is only
honest while the screen can say how many.

Each week below carries its own status and, where it is short, says that its
remainder is inside the number at the top. Nothing is carried into anything
else: `carried_in_minor` is permanently 0 and nothing reads it.

The same account answers `/me` in Telegram, in the same three states and the
same words.

## Payments (admin)

**Job.** Answer "who still owes", "record what arrived" and "what do we pay the
caterer" — and catch the money that arrived and matched nobody.

**Unmatched payments lead the screen**, above the week and outside it, because a
payment whose memo matched no reference belongs to nobody's account, changes
nothing anywhere and tells nobody. "Nobody" is `payments.profile_id is null`,
not "no statement": a top-up lands on a person and touches no week, so asking
which statement it hit would put every top-up back at the top of the screen as
a failure. Each carries the amount, the arrival in the office's zone, the
provider, and the memo *verbatim and monospaced*: the typo is the clue to whose
it was.

**All money goes in through `payments`.** Marking somebody paid records a
payment rather than updating the statement, so one trigger decides the outcome
whether the bank or an admin reported it. A hand-recorded payment sets
`provider` to `manual`, since the column defaults to `sepay`, and generates a
unique `provider_txn_id` or the second cash payment of the day collides.

**A payment belongs to a person, not to a week.** The memo names the person
through their own stable reference, and the money credits their account. It
therefore needs no statement to attach to, which is what makes a top-up
possible at all: money can arrive before anybody has eaten.

**What a week says about itself is an allocation, and it moves.**
`paid_minor` and a statement's status are that person's credits spread across
their weeks, oldest week first, recomputed whenever either side moves. So a
week can change from unpaid to paid because an older week was waived, or
because a re-bill changed what a different week costs, with nobody touching it.
"Which weeks are settled" still has an answer; it is derived rather than
recorded.

**The money is what cannot be undone.** `payments` is append-only: the trigger
is AFTER INSERT only, `amount_minor > 0` forbids a corrective row, and there is
no delete. So recording confirms in two steps, names the amount and the person,
and says plainly that nothing takes it back. That, not `paid_minor`, is the
invariant -- the older wording confused the record of a payment with the story
told about it. Waiving is not money: `status = 'waived'`, `paid_at` null, and
the week is skipped by the allocation entirely, so it consumes none of the
person's credit.

**Two totals, deliberately different.** What people owe is the sum of their
account balances, each of which counts every unpaid week exactly once. What the
caterer is owed is the sum of `billing_lines` and carries no debt, because
nobody cooked one. The screen says which is which rather than leaving them
looking inconsistent.

| State | |
| --- | --- |
| loading | skeleton shaped like the screen |
| no week billed | "No week has been billed yet" |
| week not billed yet | said plainly, with when it will be. Not an error |
| week nobody ate in | "Nobody ate this week" |
| nothing unmatched | "Every payment found its person": the reassurance, not an absence |
| settled row | the control stays; recording more leaves that person in credit rather than destroying the excess |
| memo lost its reference | warned at the confirm step, before the write |

On a phone the table keeps person, still to pay, status and the control; meals,
billed and received drop out rather than scroll sideways.

Beside Settle, one quiet link to [Corrections](#corrections-admin): settling
bills what the week records, so a day that got it wrong is put right first.

## Corrections (admin)

**Job.** Put right what the app recorded for a day that is already over, before
the week is settled.

**It is not in the nav.** The way in is one quiet link on Payments, beside
Settle, because that is where somebody is standing at the weekend when they
notice the record and the lunch disagree. The route `#/o/<slug>/corrections` is
real, so the page is linkable and survives a refresh, and a member who follows
the link gets the same admin explanation every other admin page gives. The
screen carries its own way back.

The four cases it exists for, in the product owner's words: the caterer
delivered one more portion than the app knows about because somebody ordered
verbally; a person was marked down for a lunch they did not eat; a dish was
served that was never on the menu; the caterer charged a price the menu did not
say.

**It opens on the most recent working day that is over**, because that is the
day being finalised, not today. Week navigation and the day strip are the
board's, not a third control; each day carries how many portions are recorded on
it, which is the number an admin is checking against what arrived.

**The day is a list of everybody**, the people with nothing recorded included,
so "who did we miss" is answered by reading down it. Each row carries the dish,
the portions, the note, the amount and where that person's account stands, and a
row already corrected says so.

| Control | What it does |
| --- | --- |
| Add a meal / Change | one person, one dish, one quantity, one note. The picker's last option is a dish that was never on the menu, which then asks for its price |
| This meal did not happen | the same dialog, one step on, naming what comes off that person's bill |
| Reprice | one dish, this day only, every line on it at once |
| Why | one optional line on every correction, kept with it in `order_corrections` |

**Every write says what it is about to do to somebody's money, in figures,
before it does it** -- what moves, and what that person's balance would become.
That is a preview and is worded as one. What the database returns afterwards is
the balance, and that is the only figure the screen states as fact.

**One correction, one person, one save.** No multi-row editing and no "save
all": a rarely used tool that moves money makes each change a deliberate act,
and the pending state blocks a second press.

Repricing is the one control that reaches several people at once, so it is kept
away from the rows and its confirmation counts the people, counts the portions,
and states the money going onto bills and the money coming off them separately.
A portion that carried no price at all takes the whole new one, and the
confirmation says how many of those there are.

The affected member is told by the database. The screen says so once, above the
day, rather than on every control.

| State | |
| --- | --- |
| loading | skeleton shaped like the list |
| week settled | the week named, the day it closed, and nothing offered |
| day with no menu | no price to change; a dish served anyway is still recorded against a person, with its own price |
| meal passed to somebody else | not corrected here. The row says who pays for it now |
| refused | the database's own sentence, in the dialog and in the toast, and the dialog stays open |

## Menu (admin)

**Job.** Turn the caterer's chat message into a published menu without retyping it.

Paste the message into one textarea, parse, then an **editable table** of dish and
price with the parser's uncertainty shown per row. It should feel like checking a
list, not filling a form.

Two parse paths: the offline regex parser, which is free, instant and usually
right, and "Read with AI", which calls `parse-assist`. Nothing is written until
Publish, and a human sets every price that reaches a bill.

The day picker is one week with `‹ 21–25 Sept ›`, the same control the board
uses, each day carrying its stage. It reached nineteen days as a wrapping strip
of cards once, which was a second control for a job the board had already
solved one item above it in the nav.

Every saved dish names who chose it, and the remove control carries those names
as the reason it is unavailable. The trigger refuses that write either way, but
a refusal you read after pressing is worth less than the list you needed before.

There is no un-publish. A published menu is editable in place, so it only ever
hid a day from members while lunch went on being cooked. Calling lunch off is
Cancel, which says so.

When orders close sits beside the service date, as a date and a time in the
office's zone. It defaults to the evening before at the org's default cutoff and
follows the service date until the admin sets it themselves; opening an existing
menu loads that menu's stored cutoff, so republishing to fix a price never moves
it silently. The default itself is set once in Settings.

Publishing is the highest-consequence action in the app, so it confirms, naming
the date and how many people it will notify.

| State | |
| --- | --- |
| no menu for the date | empty editor, paste prompt |
| draft | editable, Publish enabled once a dish is available |
| published | editable with a warning naming who has ordered each dish |
| locked | read only, with the reason: orders have gone to the caterer |
| cooking, served | the same; nothing on this screen reopens a day |
| parse found nothing | the raw lines, offered as manual rows. Never a dead end |
| cutoff after the meal, or being moved into the past | Publish unavailable, carrying the reason. The database refuses neither |

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

## Messages (admin)

**Job.** Decide what the office hears automatically, and say something to it now.

**It is in the nav, unlike Corrections.** Correcting a finished day is a rare
weekend job reached from where it is noticed; deciding what the office hears is
something an admin comes back to. Route `#/o/<slug>/messages`, and a member who
follows the link gets the same admin explanation every other admin page gives.

Three parts, in the order somebody arrives wanting them: the setting, the
errand, and the reason nothing works yet.

### Sent by itself

One card per kind, each with its own switch and its own Save, because they are
three unrelated decisions and a single Save would make turning one off look like
a change to everything.

| Message | Timing |
| --- | --- |
| A new menu is published | none. It goes out when you publish a day, and the card says so rather than showing an empty box |
| Ordering closes | minutes before that day's cutoff, 70 by default |
| The weekly bill | an hour of the day in the office's own zone, 09:00 by default |

The floor on the minutes is 60 and it is not taste. The bot wakes once an hour
and tests a window of exactly this length, so a window shorter than the gap
between two wakings falls between them and the last call is never sent at all.
The card says that where the number is typed.

**A missing row is today's behaviour, not an absence.** `org_notifications`
holds nothing until an admin saves something, so the screen renders the
timings the tick has always used -- on, 70, 09:00 -- and says they have never
been changed. Anything else would describe an office as having switched off
messages it has been sending for months.

Each card carries **Send me a test**, which queues the real message, to the
admin who asked and nobody else. No confirmation: it reaches one person, and
reading it is the only way to know what the office reads. It is refused, in the
database's words, when there is no published menu or no billed week to render.

### An announcement

A message, an audience of the whole office, one person, or everybody who owes
money, and a person picker that appears for the middle one alone.

**The count comes before the send and both counts come after it**, because they
answer different questions: who is about to hear this, and who did not. "Sent
to 9 people. 4 people have not connected Telegram" is the useful answer and
"Sent" is not. Sending confirms first, naming the audience and the count, the
way publishing a menu does.

### What Telegram needs to work

Last, because it explains a screen that otherwise appears to do nothing, and an
explanation read before the thing it explains is a warning. Three facts -- the
group chat, the office join code, and how many people have connected -- each
linking to the screen that owns it. The controls are not repeated here; two
places to change one setting disagree the first time somebody uses the other.

| State | |
| --- | --- |
| loading | skeleton shaped like the cards |
| nothing ever saved | the timings the office has always run on, said to be exactly that |
| nothing to save | the reason on the Save, per card |
| nobody in the audience has Telegram | Send carries the reason instead of queueing nothing |
| refused | the database's own sentence, in the dialog and in the toast, and the message is kept |

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
