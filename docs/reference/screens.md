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

**The route survives the trip.** Google sends everybody back to the bare origin,
so an invitation link or a deep link out of a chat would otherwise arrive here
and leave for the board. The hash is parked in `sessionStorage` on the way out
and put back, once, when the account loads. Sign out is for this device only.

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
| sign-in refused | Google or Supabase sent back `#error=...`: the sentence above the button, the fragment gone from the address, and the route the person started from put back, so pressing the button again lands them there |
| the account did not load | "Lunch did not load", the reason, and Try again. A dropped connection is not a sign-out, so it never shows this page |
| signed in, no office | join with a colleague's code, and below a rule, create the office yourself. Joining leads because most people are joining somebody else's office, not founding one. The words come from `my_former_offices`: somebody new is told they are not in an office yet; somebody removed is told "You were removed from Acme. Its join code will not bring you back; ask an admin there to add you back.", naming every live office they were removed from; somebody who left (or was inactive before removals were recorded) is told "You're no longer a member of Acme. Its join code will bring you back.", which does not say anybody removed them. Both lines appear when both are true |
| signed in, no office, the question failed | the words cover both cases, left and removed, rather than guess which this is, and the page still works: a failed `my_former_offices` never keeps anybody out |
| signed in, no office, founding switched off | the join code alone. `app_settings.office_creation` is a row the database holds and `create_organization` refuses on, so the second door is not hidden, it is shut: every place that offered it (this screen, the account menu, the office switcher) reads the same switch |

Joining by code and founding an office both offer an optional **short code**
field. Blank means one is made from the person's initials. It is the moment to
pick it: afterwards a member may change their own once, and then only an admin
can. A code that contains, or sits inside, a colleague's reference is refused
by the database with a sentence naming the colleague's code, shown inline and
in the toast.

## Switching office

**Job.** Cross between two offices without leaving the page you were reading.

The office name is the control, and **only above one office**: somebody in a
single office keeps a plain heading rather than gaining a menu that does
nothing, which is almost everybody.

The page carries over where it still means something: two bills compare without
a detour back to the board. The two admin chores do not, because a role does not
follow you: a member switching from an office they administer lands on the
board, not on a page explaining that the page is not for them.

The page carries over, its state does not. The week you had paged to, a filter,
a half-typed menu: all of it was about the office you left, and the screen
starts afresh in the next one.

A redirect replaces the address rather than adding to history, here and
wherever the app sends you somewhere you did not ask for, so Back goes to the
page before rather than to one that redirects again.

Creating an office lives here for somebody who already has one, and on the
sign-in screen for somebody who belongs nowhere. It has one home at a time, not
both.

## Board

**Job.** Answer "what am I eating this week" and "how many people am I ordering
for" on one screen. This is the hero and it uses the full width it is given.
From 640px up it is the grid below; narrower, it is one day at a time (see
[on a phone](#on-a-phone)).

**Your row is an action, theirs is a record.** Your own row shows your dish on
the accent fill, and every empty day on it is a control. Everyone else's cell
names their dish in an outline, because on the day the food arrives somebody has
to hand the right box to the right person. On a day with one dish the name would
repeat down the column and say nothing, so a check mark carries it instead.
Colour is spent on your own ordered cells and nowhere else.

**Every cell shows its note under the dish,** yours and everyone else's, in
smaller muted type. `ít cơm` is what tells two boxes of Cơm gà apart, so it is
on the board rather than one tap away. On someone else's cell it is read-only.
The note goes with the dish: a cell that names no dish (`to Dinh`, or a meal on
offer) shows no note either, and a one-dish day puts it under the check mark.

A note runs to 120 characters and a grid column can be 76px wide, so in a cell a
note is **held to two lines and ends in an ellipsis**, while the dish name above
it still wraps whole. Unclamped, one long note set the height of its whole row.
Two lines hold `ít cơm, không trứng` whole at every width, and text with no
space to break at still breaks, inside the word. The rest is never out of
reach: the cell's label reads the whole note to a screen reader, a pointer gets
it as the note's title, and the cell's dialog prints it in full.

```
Thursday 25 September                     Closes 21:00 24/09
Cơm gà  45.000 ₫    Bún bò  50.000 ₫     Phở bò  40.000 ₫

          Mon 22    Tue 23    Wed 24     Thu 25   Fri 26
          Served    Served    Today ·
                              Cooking
                                         ══════
You       ▓Cơm gà▓  ▓Phở bò▓  ▓Bún bò▓   [ + ]   [ + ][⚄]
          ▓ít cơm▓
Tèo       │Phở bò│  │Cơm gà│  to Dinh    ┌────┐  ┌────┐
          │không…│
Dinh      │Cơm gà│  ┌──────┐  │Bún bò│   └────┘  └────┘
          ───────────────────────────────────────────────
Total     3         2         3           0       0
```

`▓` my order, on the accent fill · `│ │` a colleague's dish, outlined · dashed
outline, eating with no dish yet · `┌┐` empty, still a target · `═` the day the
menu panel shows

`Total` counts portions, because portions are what the caterer delivers: an
admin can put more than one on somebody's order from Orders. Somebody eating
with no dish chosen counts as one. A cell of more than one portion says so,
`Phở bò × 2`, and its label adds `2 portions`.

A meal somebody gave you, once you accept it, sits on your own row as the dish
and `from Tèo`. The order stays on the giver's line, where it reads `to you`
rather than your own name, which on somebody else's cell reads as a stranger's
(the handover sheet says `passed this meal to you` too). Without it your row looked empty and offered you a second lunch for a day
you already had one. Tapping it says why there is nothing to order.

**Which days you can act on** is the first question the grid answers, and the
column head answers it in words. A day carries its stage under the date --
`No menu`, `Closed`, `Cooking`, `Served`, `Cancelled` -- and `Today` beside it
when both hold, which by mid-afternoon they usually do. An open day says
nothing, because there is nothing to say.

This used to be a tint: the whole column receded into `surface-sunken`. One
grey covered a day with no menu, a day past its cutoff and a day lunch was
called off on, so the commonest reading of it -- these are the days with a menu
-- was not one of the three things it meant. No column recedes now, and colour
here means one thing, which is *ordered*.

Every word is the same for everybody. This board is where an admin orders
their own lunch, so the clock binds them exactly as it binds a member, and
there is nothing here an admin sees that a member does not. See
[the five stages](#the-five-stages-of-a-day).

**The menu panel** above the grid names one day's dishes with prices and when it
closes, so nobody has to tap a cell to find out what is on offer. It opens on the
next day you can still order for, and a tap on any column head, or a chip in
the strip on a phone, moves it.

### On a phone

Below 640px the grid gives way to one day at a time. At 360 a week of columns
left room for a single day beside the names, so the layout turned on its side:

```
‹  28 Sept – 3 Oct  ›
┌────┐┌─────┐┏━━━━┓┌╌╌╌╌┐┌╌╌╌╌┐
│Mon ││Today│┃Wed ┃╎Thu ╎╎Fri ╎      the strip: one chip a day
│ 28 ││ 29  │┃ 30 ┃╎ 1  ╎╎ 2  ╎
└────┘└─────┘┗━━━━┛└╌╌╌╌┘└╌╌╌╌┘
Wednesday 30 September       Closes 21:00 29/09
Hủ tiếu Nam Vang 45.000 ₫ ...                     the menu panel
Wed 30                                 6 eating
Nguyễn Đình Nguyên (you)    [  +  ][  ⚄  ]        the list: a row each
Vinh Tony                   │Hủ tiếu Nam Vang│
HP                          ╎    to Tèo      ╎
```

| Part | Behaviour |
| --- | --- |
| strip | a button per visible day, `aria-pressed` on the picked one and `aria-current="date"` on today. Each chip carries my own state in my row's language: the accent fill for an order, a dashed edge for a prediction, the date struck through for a skip. `Today` takes the weekday's place |
| stage word | on the picked chip only, since seven do not fit at 320; the list heading repeats it, `Tue 29 · Today · Cooking`, and every chip's label says it to a screen reader |
| menu panel | the picked day's, as on the grid |
| list | everyone for the picked day, with the day's portions in its heading (`6 portions`, `1 portion`). Every cell is the grid's own, drawn by the same code and calling the same actions, so ordering, the dice, skipping, handing over and Accept or Decline behave identically |
| opens on | the next day you can still order for, as the grid does |
| swipe | sideways on the list moves one day. A mostly vertical drag, a pinch or a touch on the strip does not. It is an enhancement: the strip is how a keyboard or a screen reader changes day, and if a swipe takes away the cell that had focus, focus moves to the list, whose name is the day it now shows |
| resize | crossing 640px keeps the picked day and anything open, and the grid scrolls to that day |

Every target on a phone is at least 44px each way. A seven-day week at 320 is
the one case the strip does not fit, and there it scrolls sideways, keeping the
picked chip in view.

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
| a note | `ít cơm`, `không trứng`: a field under the dish, up to 120 characters, saved against the dish and shown under it in the cell, to everyone |

The dice is offered only where there is something to randomise. Randomising is a
first-class choice, not a fallback: on most days nobody minds which of three
similar dishes arrives, and the people who do mind take the `+` instead. "Eating,
dish not chosen" therefore never arises from a tap. It survives only for a
standing order on a menu of several dishes, which is the one case where the
system genuinely cannot guess; with one dish, the system gives it that dish.

Anyone opening a colleague's cell reads that colleague's note in full, under
`How they want it`, which is where a note clipped in the cell is read whole.

Cells are **optimistic**: they fill immediately and revert with the database's own
sentence if refused, e.g. `ordering for 23/09 closed at 21:00 22/09`.

### Skipping and planning a day ahead

On your own row, a day **ahead of its menu** is one tap away from the other
side of your standing days. That is a day after today with no menu yet, so no
order row of yours either. Only your own row, admin or not.

| Cell | Means | Tap |
| --- | --- | --- |
| `Standing`, dashed strong edge | your weekday rule covers it | skip it: writes `skip` |
| `Skipped`, struck through, dashed hairline, muted | a rule day you are off | take it back: removes the `skip` |
| `+`, hairline | off the rule, nothing planned | plan it: writes `force` |
| `Planned`, dashed strong edge | off the rule, you will eat | take it back: removes the `force` |

Every one is dashed or bare because it is still a prediction: the accent fill
stays with real orders. The cell flips at once and the toast says what it now is,
`Skipped Thu 24 Sept`, with **Undo**, which puts back whatever exception was
there before (a plan on a day the rule later came to cover, for instance). The
Undo's own toast has no Undo. An Undo on a day that has moved on since, most
often because its menu was published meanwhile, writes nothing and says so:
`The menu for Thu 24 Sept is out, so order or cancel that day instead`. A refusal puts that one day back and shows the
database's sentence, e.g. `the menu for 24/09 is already out, so order or cancel
that day instead`.

| Day | My cell |
| --- | --- |
| menu published and open | ordering, exactly as above |
| today, or earlier, with no menu | inert, `No menu for Tue 22 Sept yet` on tap |
| locked, closed, cancelled, served | inert, the stage's reason on tap |
| an order row of mine exists, even cancelled | the order cell; skip does not apply, cancel as usual |

There is **no horizon**. The week arrows page forward without limit, and a week
with no menus and no orders still shows your projection and takes skips. A
skipped weekend day keeps its column, so the skip can be taken back.

When a menu is published for a skipped day, no standing order is created for
you; for a planned day, one is, with no dish chosen. That is
`materialize_standing_orders` as it always was.

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
their own lunch from this board exactly as a member does. Recording a swap
between two other people is a correction of what was written down rather than
an arrangement between two people, so it lives on [Orders](#orders-admin).

An offer made to you appears on the cell of the meal it concerns, which is the
giver's cell on their row, with Accept and Decline inline. A pending offer is
legible on the board as the recipient's name on the cell, so nobody offers a
meal that is already spoken for. Cancelling a meal that is on offer, or lunch
being cancelled, withdraws the offer, so it leaves both cells; Accept or
Decline from a board loaded before then is refused in the database's words,
`the lunch on 24/09 offered to you was cancelled, so there is no meal to
accept`.

Sentences, not icons. A cell is a person and a day, so a tap could mean give or
take, and that is a difference of grammar rather than appearance: two arrows would
need a legend, and a board that needs a legend has already lost.

The window for a member ends when the day does, at the office's end of day.
People remember on Thursday that Tuesday's lunch went to somebody else, but by
Thursday Tuesday's lunch has been eaten, and recording it then is bookkeeping
rather than an arrangement. Once a day is `Served`, `Give Tèo my Bún bò` carries
`Lunch on 24/09 is over, so it can no longer be passed on`, and an offer still
waiting on that day stays legible with Accept and Decline unavailable, since
the database would refuse either. The database keeps an admin's window open for
the whole billing week, and nothing on this screen spends it: the board holds
an admin to the same end of day.

| State | |
| --- | --- |
| loading | skeleton shaped like the grid, or like the strip and list on a phone |
| no menu that day | the cell is inert and says so on tap; the panel says it too |
| cutoff passed | the column head says `Closed`, and the cell carries the database's sentence on hover, focus or tap. Nothing recedes |
| lunch is over | the column head says `Served`; handing a meal over and answering an offer are unavailable, with the reason |
| a load answers late | only the newest load is drawn, so paging weeks quickly never shows last week's orders under this week's dates |
| no members but you | the board still renders; an office of one is not an error |

## The five stages of a day

Every screen that shows a day shows its stage, and they all derive it the same
way, from `dayStage` in `shared/gating.ts` mirroring `private.day_stage`.

What each stage allows, and who, is in
[Ordering rules](ordering-rules.md#day-stages).

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

**No code outside dong.** A VietQR payload always says VND and whole dong, so
an office billing in anything else gets the reference, account and bank with no
code, no Share or Download, and one line saying why.

**Under the code, Share QR or Download QR.** The code as a PNG, black on
white whatever the theme, with the amount, the reference and the payee printed
under it, named `lunch-<reference>-<yyyy-mm-dd>.png`. Where the browser can
share files (iOS Safari, Android Chrome) it opens the share sheet, whose text
carries the amount and the reference, and "Save Image" is one of its rows;
anywhere else, desktop included, it downloads. Banking apps scan from the photo
library, so this is the shortest way from a phone's bill to a paid one. The
image is drawn when the code is, not on the tap, because Safari refuses a share
that starts too long after the tap that asked for it; until it is ready, or on
a browser that cannot draw it, the button carries the reason.

**On a phone, Open your bank app.** Only when all of these hold: the device is
an Android phone, an iPhone or an iPad (from the user agent; an iPad reports a
Mac with a touch screen), the office bills in VND, something is owed, and the
office's account makes a valid code. Nobody settled or in credit sees it.

| | |
| --- | --- |
| first time on this device | **Open your bank app** opens a picker of that platform's apps, text only, with a filter that ignores case and diacritics. Picking one remembers it (`localStorage`, `lunch.bankApp`) and opens it |
| after that | **Open &lt;app&gt;**, one tap, and **Other bank app** to change it |

The tap copies the reference and goes to
`https://dl.vietqr.io/pay?app=<appId>`, which names the app and carries no
account, amount or reference.
On iOS that opens in a new tab, in the tap's own tick: the redirector there is a
page that tries the app and, if it still has focus a few seconds later, moves on
to the App Store, which in the bill's own tab would take the bill with it. On
Android it is the same tab, because the redirect is an `intent://` hand-off that
leaves the page alone. Either way the bill then says, in a line that stays, that
the reference is copied and to paste it, or that it could not be copied and to
type it.
The app opens on its own home screen: VietQR's redirector drops the account,
amount and memo for every app as of 2026-09-28, which is why the link does not
send them, and the line under the button says the transfer will not be filled
in. The app list is vendored and the link
depends on `dl.vietqr.io`; see
[Refresh the bank app list](../how-to/refresh-bank-app-list.md).

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
caterer", and catch the money that arrived and matched nobody.

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

**A payment is never edited, and a mistake is put right on the record.** An
admin can insert a manual payment and nothing else: no UPDATE or DELETE on
`payments`, statements, lines or periods. Recording confirms in two steps and
names the amount and the person. What was wrong is fixed through three RPCs,
each writing `payment_corrections` with who did it and why:

- **Apply** (money that matched nobody) and **Move** (money on the wrong
  person) are one call, `move_payment`: the payment itself moves, both
  people's weeks are redrawn, and no second row is written. Applying used to
  record a copy that pointed at the stray in `raw`; those older pairs still
  retire the stray from the list.
- **Void** is offered on manual payments only, in the person's dialog, and
  asks why. The row stays, marked void, and counts towards nobody. Money the
  bank reported did arrive, so it is moved, never voided.
- **Waive** stops asking for one person's week: `status = 'waived'`, `paid_at`
  null, skipped by the allocation entirely, so it consumes none of their
  credit. There is still no un-waive on this screen. If a re-bill deleted the
  week while the dialog was open, the refusal says so and the list reloads.

The person's dialog lists the payments on their account, newest first, with
Move on each and Void on the manual ones. When a move or void is refused (for
instance because somebody else moved the payment first), the refusal is shown
and the list reloads; a refused move also closes its dialog, and a refused void
refreshes the person's payments.

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
| void without a reason | the Void control carries "Say why it is being voided." |
| move or void refused | the database's own sentence in the toast: not an admin, already voided, a bank payment, or already on that person |

On a phone the table keeps person, still to pay, status and the control; meals,
billed and received drop out rather than scroll sideways.

Beside Settle, one quiet link, **Put a day right**, to [Orders](#orders-admin)
on the week being settled: settling bills what the week records, so a day that
got it wrong is put right first.

## Orders (admin)

**Job.** Answer "what did each person have, and what are they paying for it"
for one week, and let an admin set it for anyone, on any day with a published
menu, until the week is settled. Two uses cover almost all of it: ordering,
changing or cancelling on somebody's behalf, and recording what happened
outside the app (a verbal order, a lunch not eaten, a swap, an off-menu dish,
a price the caterer changed).

First in the Admin group of the nav, route `#/o/<slug>/orders`. It replaced
Corrections: `#/o/<slug>/corrections` redirects here, keeping its query and
adding no history entry. `?week=<date>` opens that week, which is how
**Put a day right** beside Settle on Payments opens the week being settled. A
member who follows an `orders` link reaches the Board, because `orders` was
the Board's name in the old five-tab app.

The Board stays as it is and keeps the member's clock for admins too. This is
the one screen where an admin steps outside it, and every step is on the
record.

**The Board's frame, with the day's prices in the panel.** `WeekNav` with the
week number, a line saying each save bills and messages at once, the day
panel, then the grid (people down, days across, a `Total` row of portions and
money). On a phone: the Board's day strip, whose chips carry the day's portion
count rather than my own state, then the panel, then the picked day's list
(`Wed 30 · Served`, `8 portions`). Under both, `Changed by an admin on Wed 30
Sept`: the day's `order_corrections` rows with their kind, summary, who and
when, and `Why:`. Each row header carries the person's balance in the Bill
screen's words (`owes 185.000 ₫`, `has 20.000 ₫ in credit`). Weekends get a
column only when a menu exists for the day.

**It opens** on the current week, or on the week a `?week=` names, and follows
that parameter if it changes while the screen is open. It opens with the panel on the most recent working day
that is over, because that is usually the day being checked. When that day is
not in the week shown, the panel starts on the next day still open for
ordering. A tap on a column head, or a chip, moves it.

**The panel** names the day, its stage sentence (`Served. Open to record until
the week is settled`, `Closed at 21:00 30/09`, `Closes 21:00 01/10`), and each
dish with `3 people, 4 portions`, its price and **Reprice**. Reprice opens the
reprice dialog, which counts people and portions and states the money going
onto bills and coming off them separately; on a day not served yet the field
reads `New price` rather than `What the caterer charged`. A day with no menu
says why and links to the Menu screen on that date
(`#/o/<slug>/menu?date=<date>`).

### Cells

Every cell is a record, so none wears the accent fill, the admin's own row
included. Where a meal came from is a word under the dish, which needs no
legend: none means the member or their standing days made it, `recorded`
means an admin did (`source = admin`), `corrected` means the member did and an
admin changed it since.

| State | Drawn as |
| --- | --- |
| a meal | solid `border-strong` outline, the dish (`× 2` above one portion), the note held to two lines, then the provenance word |
| no price yet | `Price to come` on a `warn-subtle` chip; the week cannot settle while it is there |
| eating, no dish | dashed outline, `no dish yet` |
| passed and accepted, on the giver's row | `surface-sunken`, the dish struck through (`× 2` above one portion), `to Dinh` |
| received, on the recipient's row | their own cell as usual, plus `+ 1 from Tèo`, with the portions the meal brought |
| offer waiting | dashed accent edge, `offered to Thảo Vy` |
| nothing, day open to record | hairline and a faint `+` |
| nothing, day not open to record | no edge; the reason on tap, focus and hover |

Each cell is one button whose label speaks the whole state, the note in full:
`Tèo, Wed 30: Bún chả Hà Nội, 2 portions, recorded by an admin. Change`.

| Day | Cells | Reason |
| --- | --- | --- |
| published, open | open to record | |
| closed or cooking (cutoff passed, today or ahead) | open to record, and every dialog carries the cutoff warning | |
| served | open to record | |
| no menu | inert | `No menu for Tue 22 Sept. Add the day on the Menu screen to record a lunch on it.` |
| cancelled | inert | `Lunch was cancelled on Thu 24 Sept` |
| any day of a settled week | read only | the notice at the top |

### Dialogs

A tap never writes. It opens one dialog for that person and that day,
remounted per cell so it never carries the last cell's dish or note. The
dialog focuses its title, so a stray keypress changes nothing; Escape closes it
and focus goes back to the cell. It is dismissed with **Close**, never
"Cancel", because cancelling a meal is one of the things it does. Enter in a
field saves nothing.

Every write shows its figures directly above the button, worded as what would
happen and naming the person, and the button names the person too. The toast
reports the balance the database returned, the only figure stated as fact. A
refusal is the database's own sentence, in the dialog and in the toast; the
dialog stays open and the week is read again underneath it, since a refusal
usually means the week moved.

| Step | What it shows | Button | Toast |
| --- | --- | --- | --- |
| add or change | the day line and stage (`Friday 2 October · open until 21:00 Thu 1 Oct`), who made the meal as a sentence (`Tèo ordered this.`, `Recorded by Nguyên on 30/09 14:05.`, `Quy ordered this, and Nguyên changed it on 30/09 15:00.`), the dishes as a radio list with prices ending in `A dish not on the menu` (which asks for its name and price and echoes the price as read; a name that matches a dish already on the day, ignoring case and spacing, says so on a `warn-subtle` line: a priced match is saved as that dish at its own price, which the preview uses; an unpriced one cannot be saved, and Save carries `"Mì Quảng" is already on the menu with no price yet. Set its price with Reprice, then record this meal`), portions as a stepper from 1 to 20, the note, Why, and the preview (`This would put 45.000 ₫ on Tèo's bill. Tèo owes 185.000 ₫ now, and would owe 230.000 ₫.` and `Tèo gets a message saying what you saved.`) | `Save Tèo's meal` | `Saved Tèo's meal. Tèo owes 230.000 ₫.` |
| remove, a step on | `The record says Tèo had Bún chả Hà Nội × 2.` for a day that is over, `Tèo is down for Phở gà.` ahead, the money off on a `warn-subtle` block, Why | `Remove Tèo's meal` (danger), and Back | `Removed Tèo's meal. Tèo owes 85.000 ₫.` |
| pass, a step on | `Whoever you pick pays for it instead of Thảo Vy.`, everybody else as a radio list, each saying `has lunch that day` or `nothing that day` (a search above ten people), Why, both people's figures, `Both of them get a message saying what you recorded.` | `Pass to Dinh`, and Back | `Passed Thảo Vy's Bún bò Huế to Dinh.` |
| a passed meal | the dish and amount, `Tèo passed this meal to Dinh, and Dinh accepted it on 29/09 at 11:20. Dinh pays for it.` (or who recorded it), Why, the figures moving back; Change and Remove stay, and their figures are the payer's | `Undo the pass` (outline) | `Undid the pass. Tèo pays for Cơm tấm sườn again.` |
| an offer waiting | `Tèo offered this to Thảo Vy, who has not answered.` with `Accept for Thảo Vy`, `Decline for Thảo Vy` and `Withdraw Tèo's offer`, each a step with its figures; the pass link carries `Answer or withdraw the offer first` | the step's own verb | `Accepted Tèo's offer for Thảo Vy.`, `Declined …`, `Withdrew Tèo's offer.` |
| a settled week | the dish, the full note, who made it, the pass, and that person's changes on the day | Close only | |

**The cutoff warning.** On a day at `Closed` or `Cooking`, a `warn-subtle` note
tops every step: `Ordering for Thu 1 Oct closed at 21:00 30/09.` and `The
caterer may already have the count and be cooking. If this adds a portion,
tell them yourself: the app will not.` No checkbox and no extra step. A served
day gets none, since the count no longer matters.

**The admin's own row** is treated like anybody else's here: after the cutoff
too, audited, messaged, with the same warning. On the Board an admin is held to
the member's clock exactly as before.

What each write may do is in [Ordering rules](ordering-rules.md#orders).

| State | |
| --- | --- |
| loading | a panel block and the Board's skeleton, grid or strip and list |
| did not load | "The week did not load", the error, and Try again |
| no menus this week | "No menus this week" and how to add one; the grid still lists who is in the office |
| a late answer | only the newest load is drawn |
| settled week | a `surface-sunken` notice: `The week of 21 to 27 September was settled on Mon 28 Sept at 09:00. A settled week is already billed and paid against, so nothing on it can change. Cells open to show what was recorded.` No Reprice, no `+`, no hover |
| office of one | renders normally |

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

**Which saved dish a row is.** Publishing updates a row that carries a saved
dish's id, inserts one without, and deletes every saved dish no row carries
(`publish_menu`). Once the day has saved dishes, each row shows which it is:
the id in muted text, `#230`, for a dish updated in place (its orders stay),
or `New` for one inserted. A day with nothing saved shows no tags, since every
row would say `New`. The name box is described by the tag, so a screen reader
hears "Saved dish #230, updated in place" or "New dish, added when you
publish".

- **Matching on a parse.** Parse and Read with AI give a row the id of a dish
  with the same name (NFC, trimmed, any case, the rule of `menu_items`' unique
  index), looked for first among the rows on screen, then among the saved
  dishes, so a dish an earlier parse dropped is recognised when a later one
  brings it back. Each id goes to one row. A reworded name is `New`.
- **Editing a name by hand** keeps the id: it is a rename. A row with no id
  whose typed name matches a saved dish no other row carries takes that id,
  by the same rule, and gives it back if typing goes on past the match.
- **Same dish as.** A `New` row, while any saved dish is about to be removed,
  offers a select of those dishes. Choosing one gives the row its id, so a
  reworded dish becomes a rename and keeps its orders. A renamed row shows the
  same select set to the dish it renames, and `None, a new dish` detaches it.
- **Will be removed** lists, under the table, the saved dishes no row carries,
  struck through, with id and price. A dish with an order line on it cannot
  be deleted (`order_items_menu_item_fk`), and a cancelled order keeps its
  lines, so every line counts. The one exception is a line the system wrote
  on a one-dish menu, which goes with its dish while the day is open; after
  the cutoff it holds the dish too, judged at the cutoff being published. One
  chosen on a placed order names who; one chosen only on cancelled orders
  says it was ordered and cancelled and stays on the record; one the system
  gave out says somebody is down for it as the day's only dish and ordering
  has closed. Either way Publish carries the reason (`"Bún bò" would be
  removed, and somebody chose it. Keep it, or mark its new row as the same
  dish`). **Keep** puts a dish back at its saved place with its id and moves
  focus to its name box.
- **Orders are read again when Publish is pressed**, so a dish chosen while
  the admin was checking holds the confirmation's Publish, with the reason. If
  the database still refuses a removal, the error names the dish, the orders
  are read again, and the list being checked stays.
- **Names trading places.** `publish_menu` renames kept dishes one by one in
  list order, so a kept row cannot take a saved name that a kept dish further
  down is only giving up in the same publish (a swap, or such a chain).
  Publish carries the reason and asks for one rename to be published first.

There is no draft and no un-publish: a day has a published menu or none.
A published menu is editable in place, and calling lunch off is Cancel, which
says so.

When orders close sits beside the service date, as a date and a time in the
office's zone. It defaults to the evening before at the org's default cutoff and
follows the service date until the admin sets it themselves; opening an existing
menu loads that menu's stored cutoff, so republishing to fix a price never moves
it silently. The default itself is set once in Settings.

Publishing is the highest-consequence action in the app, so it confirms, naming
the date, how many people it will notify, and what it does to the dishes:
`2 dishes updated, 1 new, 1 removed` (only the parts that happen, the noun on
the first), then the removed dishes by name.
What publishing, editing and cancelling do is in
[Ordering rules](ordering-rules.md#menu-lifecycle).

| State | |
| --- | --- |
| no menu for the date | empty editor, paste prompt; Publish enabled once it has a dish |
| published | editable with a warning naming who has ordered each dish |
| a saved dish left out of the list | under Will be removed, with Keep; Publish unavailable, with the reason, if it was ever chosen, cancelled or not |
| locked | read only, with the reason: orders have gone to the caterer |
| cooking, served | the same; nothing on this screen reopens a day |
| parse found nothing | the raw lines, offered as manual rows. Never a dead end |
| cutoff after the meal, or being moved into the past | Publish unavailable, carrying the reason. The database refuses neither |

### The order for the caterer

Below the editor once the day's menu is published or locked: the message the
admin pastes into the caterer's chat, in Vietnamese because the caterer reads
it. It is offered before the cutoff too, marked as a count that can still
change.

The office's **template** fills an editable text box. The admin adds what is
special about the day, typically the notes, then presses **Copy the message**,
which copies the box exactly as edited. Nothing keeps the edit: it is copied
at once. **Reset** reads the orders again and refills the box from the
template, discarding the edit.

The template's placeholders are data only, so every word the caterer reads is
one the office wrote:

| Placeholder | Becomes |
| --- | --- |
| `{companyName}` | the office's name |
| `{servingDate}` | the day, `24/09` |
| `{dishes}` | one line per dish ordered, with its portions, `- Cơm gà: 3`. A dish nobody ordered is left out |
| `{total}` | portions in all |
| `{unchosen}` | people eating with no dish chosen, as a number, `0` included |

The default is `Đặt cơm {servingDate}` / `{dishes}` / `Tổng: {total} phần`.
**Edit template** opens a dialog with the template, what each placeholder
means, a preview built from the day on screen, **Restore the default**, and
**Save**. Saving refills an unedited box the way Reset does, orders read again.
An edited box is kept, with a line saying Reset applies the new template. The default is stored
as nothing, so an office that restores it follows any later improvement to it.

Every note on the day is listed under the box as dish, person and note, since
the message does not carry them.

| State | |
| --- | --- |
| loading | nothing yet |
| failed to load | the error and Try again |
| nobody has ordered | "Nobody has ordered for this day, so there is nothing to send the caterer", with no box and no Copy |
| box emptied | Copy carries "The message is empty. Reset fills it in again." |
| browser refuses the clipboard | Copy carries the reason; select and copy by hand |
| people eating with no dish | a warning with the count, which the total leaves out, whether or not the template uses `{unchosen}` |
| template without `{dishes}`, or with an unknown placeholder | Save carries the reason, and the database refuses it too |

## People (admin)

**Job.** Get somebody in, and notice somebody who should not be.

The join code leads, large, with copy, QR, when it was last set, and Rotate.
Email invitations are demoted to a secondary option, because most members join
from Telegram and have no email address.

Recent joins are listed beneath the code with names and times. That is the safety
mechanism: a leaked code is noticed, not prevented. See
[join-codes](../explanation/join-codes.md).

Member list with roles below. **Every disabled control states why**: you cannot
change your own role or remove yourself (leaving is in Settings), and an admin
cannot change, remove or add back an owner. Owners can do everything an admin
can. An inactive member carries **left** or **removed**, because only the
second is kept out of the join code; **Remove** on an active row, **Add back**
on an inactive one, and adding back is the way in for a removed member (a new
invitation is the other). A row of grey controls
with no explanation is what made this screen look broken while it was working.

Who is on Telegram heads the list, "9 of 12 on Telegram", counting active
members only, because somebody who never linked hears none of the bot's direct
messages, the weekly bill included. Each row carries **Telegram: linked** with
the date it happened, or **Telegram: not linked**. Linked means the member
finished /start, so a link row with no chat yet counts as not linked. A link
older than the column that records its date shows no date rather than a made-up
one. Removing or leaving keeps the link, so an inactive member who linked reads
**Telegram: linked, not in the office**, in grey rather than green. If the read
fails, the count reads "Telegram status unavailable" and the rows carry no
Telegram line; the rest of the screen still works. The read is `telegram_links` filtered to rows with a chat, selecting
`membership_id` and `linked_at` alone: the chat id never reaches the browser,
and `link_token` is not selectable by any browser role.

| State | |
| --- | --- |
| only you | the code, and "Share this to add your first colleague" |
| no code set | "No join code yet" with Create |
| role changed | toast, "Now an admin" |
| removed | toast, "Removed Tèo"; the row stays, marked removed |
| added back | toast, "Added Tèo back" |
| nobody linked | "0 of 12 on Telegram", every row not linked |
| Telegram read failed | "Telegram status unavailable", no Telegram line on any row |

## Messages (admin)

**Job.** Decide what the office hears automatically, and say something to it now.

**It is in the account menu, not the nav,** under Settings, for an admin or
owner, on every width. It is the least frequent of the chores, and the phone's
tab bar had no room for a seventh tab once Orders joined it. Route
`#/o/<slug>/messages`, and a member who follows the link gets the same admin
explanation every other admin page gives.

Three parts, in the order somebody arrives wanting them: the setting, the
errand, and the reason nothing works yet.

### Sent by itself

One card per kind, each with its own switch and its own Save, because they are
unrelated decisions and a single Save would make turning one off look like
a change to everything.

| Message | Timing |
| --- | --- |
| A new menu is published | none. It goes out when you publish a day, and the card says so rather than showing an empty box |
| Ordering closes | minutes before that day's cutoff, 70 by default |
| The weekly bill | an hour of the day in the office's own zone, 09:00 by default |
| Money arrives | none. It goes out when a payment is credited to somebody, to them |
| A transfer matches nobody | none. It goes out when a bank transfer names nobody, to the office's admins and owners |

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
database's words, when there is no published menu or no billed week to render,
when the admin has no payment of their own for the receipt, or when no bank
transfer has matched nobody yet for the alert.

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
link or its connected state, display name, short code, sign out. Not a tab: it
would compete with the two things people do weekly, and lose.

Under the standing days, once at least one is on: `Skip single days by tapping
them on the Board.` and, when there are any, `2 upcoming days skipped`, linking
to the Board on the week of the first (`#/o/<slug>/board?week=<date>`). Only
skips the Board would draw as `Skipped` are counted: on a weekday the rule
still covers, and on a date with no order row of mine, cancelled included. The
Board takes `week` only when it is a real date in the years 2000 to 9998, and
otherwise opens on this week. Changing a weekday writes the rule and nothing else:
skips and plans on single dates are kept.

The **short code** says how many changes are left. A member has one after
joining; once it is used the field is disabled and Save carries "You have used
your one change. An admin can change it for you." An admin or owner is told
they can change it whenever they need to, and is never counted. A refusal for
being too close to a colleague's code is the database's sentence, as it comes.

An admin also sees **Your office**: when ordering closes, the bank account,
and the **Telegram group chat**. The group chat card does not ask anybody to
know a chat id: its hint says the bot posts the ID in the group as it is added,
and the field takes that number pasted as it comes. Empty clears it; anything
but a whole number keeps Save unavailable with "A chat id is a whole number,
like -1001234567890".

The **theme** lives in the account menu itself rather than on the settings page,
beside sign out, because it is the one preference somebody changes on a whim and
wants to see take effect in the same breath. Three states, `System / Light /
Dark`: a two-state switch cannot say "follow the machine", so the first thing it
does is quietly stop following it. The choice is kept in `localStorage` and
applied to the document element before first paint.

## Report a bug (behind the avatar)

**Job.** Tell the owner something is broken without having to describe where.

Every signed-in person has **Report a bug** in the account menu, directly above
Sign out. It opens a dialog with one field, what went wrong, up to 2000
characters. The rest is attached rather than asked for: the page (the hash
route, query included), the app version (`package.json` version plus the build's
commit), the browser's user agent, the window size, and, from the database, the
time, the reporter and the office.

It goes to the owner of the office you are in, never to its admins. An owner
with Telegram connected gets it as a message at once; every owner can also read
it on [Bug reports](#bug-reports-owner).

| State | |
| --- | --- |
| empty | Send report carries "Say what went wrong first" |
| sending | the button reads Sending and refuses a second press |
| sent | toast "Report sent", and the dialog closes |
| refused | the database's own sentence, inline and in the toast, and the text is kept. Ten reports an hour per person is the limit |

## Bug reports (owner)

**Job.** Read what people reported, and keep track of what is dealt with.

In the account menu under Settings, for an **owner only**, whether or not their
Telegram is connected: Telegram is where a report arrives, this is where it is
kept and marked resolved. Route `#/o/<slug>/bug-reports`. Anybody else who
follows the link is told the page is for the owner; RLS returns them nothing
either way, so the explanation is what stops an empty list reading as "nobody
has reported anything".

Newest first. Each report shows who sent it, when in the office's zone, the
description as plain text, and its four context fields, with "Not recorded"
for any the browser did not supply. **Resolve** and **Reopen** are one column,
`resolved_at`, and the only thing an owner may change: the words are the
reporter's.

| State | |
| --- | --- |
| loading | skeleton shaped like the cards |
| nothing reported | "Nothing reported yet", and where reports come from |
| did not load | the reason, and Try again |
| resolved | a Resolved badge, the description muted, and Reopen |

## Join (invitation link)

**Job.** One decision, taken immediately.

Reached from an emailed invitation, after sign-in. It says where the link leads
before it offers anything: `invitation_preview` reads the invitation by its
token for somebody not yet a member, since RLS keeps invitations to admins.

| State | |
| --- | --- |
| loading | two skeleton lines and no Accept |
| valid | "Join Acme", the role ("as a member" or "as an admin"), the date it is valid until, and Accept |
| not valid | "Invitation not found": the token matches nothing, is malformed, or its office was deleted. No Accept |
| expired | "Invitation expired", naming the office and the date, and asking an admin there for a new one. No Accept |
| used | "Invitation already used", naming the office, and a link to the person's offices. No Accept |
| the preview did not load | the reason and Try again |
| accepted | the office's name and a link to that office's board, not to whichever office the person happened to belong to first |

Errors on Accept come from `accept_invitation` verbatim: expired or used since
the page loaded, addressed to a different account, or an account with no email
address at all.
