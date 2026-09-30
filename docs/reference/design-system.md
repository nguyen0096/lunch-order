# Design system

The rules the interface is checked against. A screen that breaks one of these is
wrong even if it looks fine, because the cost of an inconsistency is paid by
every future screen, not this one.

## What this app is

A shared weekly board for an office lunch order. Vietnamese food, Vietnamese
names, prices in whole dong. Many people order from Telegram, but the web app is
used mainly on phones, opened from a chat link: to order, to hand a meal over,
to see the bill. An admin publishes a menu and settles the week on the same
screens, often at a desk.

So every screen works at 320px first and uses the width it is given above that.
The old CSS got the first half and not the second (`mobile-first, one
breakpoint`), which is why it looked like a phone app stretched across a
monitor.

## Non-negotiables

1. **No raw color, spacing or font size in a component.** Tokens only. A hex
   literal outside the token file is a bug.
2. **Every mutation reports.** One hook handles pending, success and failure, so
   no screen invents its own. An action that silently succeeds is a defect.
3. **Every disabled control carries its reason**, and the reason is visible, not
   just implied by the grey. A row of controls disabled with no explanation is
   what made the old People screen look broken when it was working. The reason
   opens on hover, on focus and on a tap: a phone never hovers, and a reason only
   a mouse can reach is no reason at all on the device most people order from.
4. **Every list has an empty state that says what to do next.** Not "No data".
5. **The verb does not change.** A button that says Publish produces "Published".
   Same word through the whole flow, so the interface teaches its own vocabulary.
6. **AA contrast, visible keyboard focus, reduced motion respected.** Not a
   later pass.

## Color

The brand is four values. Everything else is derived, and components never name
these directly: they use the semantic layer below.

| | hex | role |
| --- | --- | --- |
| gold | `#E7CD80` | tints, selected rows, the pale end |
| ochre | `#AF7305` | the working accent: today, ordered, primary action |
| brown | `#825734` | secondary text and marks |
| bark | `#77481E` | headings, dark surfaces, the deep end |

Warm ochre and brown suit the subject: turmeric, caramelised `thịt kho`, bamboo
trays. Deliberately **not** a cream background with a serif display, which is the
most recognisable machine-generated look and sits one step from this palette.
Paper white, ochre used as a working colour rather than a decorative wash.

Semantic tokens are what components consume:

```
--surface            page
--surface-raised     cards, dialogs, sticky headers
--surface-sunken     table zebra, wells
--text               body
--text-muted         secondary
--text-subtle        captions, disabled labels
--border             hairlines
--border-strong      focused and selected edges
--accent             ochre
--accent-fg          text on accent
--accent-subtle      tinted background from gold
--success --warn --danger  (+ -fg, -subtle for each)
```

Every pair ships a dark-mode value. Contrast is verified, not assumed: `#AF7305`
on white is close to the AA boundary for small text, so the accent is a
**background** with dark text on it, or a **large** foreground, never small ochre
body copy on white.

**One hue, and it means ordered.** Today and ordered both used the accent once,
which made each vaguer. Today was then an accent rule down the column edge, and
that was worse: a rule between two columns reads as a divider, not as a property
of one of them, and the first person to see it read it as "past days are not
editable". So the accent is spent on *ordered* alone.

What the grid has to answer first is **which days you can act on**, so a day you
cannot order on recedes into `surface-sunken`, across its head, its cells and its
total. Today is a word, `Today`, under the date in the column head. Colour for
the thing you do, a label for the thing you orient by.

A colleague's cell is read the same way, by fill rather than by glyph: *ordered*
is a filled `accent-subtle` block, *eating with no dish yet* is the same fill
under a dashed edge, *passed on* is a `surface-sunken` block carrying the
recipient's name, and *nothing* is an empty cell inside a hairline. Size is the
weakest channel there is, and the five sizes of dot this replaces could not be
told apart while scanning a week.

A day of mine ahead of its menu is a prediction, so it never takes a fill.
`Standing` and `Planned` sit under a dashed `border-strong` edge, `Skipped` under
a dashed hairline in `text-subtle` and struck through, and an unplanned day is the
plain hairline with a `+`. The dash says "not an order yet"; the strike says
"not this one".

**The theme is a choice, not only a preference.** The tokens follow
`prefers-color-scheme` by default, and `System / Light / Dark` in the account menu
overrides it by putting `.light` or `.dark` on the document element. System means
system: the class comes off and the media query decides again. The class is set
by an inline script in `index.html` before the stylesheet applies, because a
theme chosen after first paint is a flash of the wrong one.

## Type

**Be Vietnam Pro**, one family, weights 400/500/600.

This is a deliberate choice, not a default. The content is `Cơm gà`, `Phở bò`,
`Bún bò Huế`, and `Nguyễn`. Most faces stack Vietnamese double diacritics badly
(`ầ`, `ệ`, `ỡ`) or fake them; this one is drawn for the language. A lunch board
that cannot set its own dish names is not finished.

Scale, minor third, 16px base: `12 / 14 / 16 / 20 / 25 / 31 / 39`.
Body under 80 characters. Numerals tabular everywhere money or counts align.

## Layout

The board is the hero: a week of dates across, people down, and it should use the
width it is given. It is a table, semantically and visually, because it is one.

```
┌───────────────────────────────────────────────────────────┐
│  Test Office              Board   Bill        Menu People │
├───────────────────────────────────────────────────────────┤
│  ‹  22–26 Sept                                 This week ›│
│                                                            │
│            Mon 22    Tue 23     Wed 24    Thu 25   Fri 26 │
│            ▒▒▒▒▒▒    ▒▒▒▒▒▒     Today                     │
│                                 ══════                     │
│  You (me)  ▓Cơm gà▓  ▓Phở bò▓   ▓Bún bò▓   [ + ]   [+][⚄] │
│            ▓ít cơm▓                                        │
│  Tèo       ▓▓▓▓▓▓▓▓  ░░░░░░░░   ▒to Dinh▒  ┌────┐  ┌────┐ │
│  Dinh      ▓▓▓▓▓▓▓▓  ┌──────┐   ▓▓▓▓▓▓▓▓   └────┘  └────┘ │
│            ──────────────────────────────────────────────  │
│  Total     2         1          2          0       0      │
├───────────────────────────────────────────────────────────┤
│  Wednesday 24 September                  Closes 21:00 23/09│
│  Cơm gà    45.000 ₫   Bún bò  50.000 ₫   Phở bò  40.000 ₫ │
└───────────────────────────────────────────────────────────┘
   ▓ ordered (filled)   ░ eating, no dish yet (dashed edge)
   ▒ recessive: a day you cannot act on, or a meal already passed on
   ┌┐ empty, and still a target    ══ the day the menu panel is showing
```

Left aligned throughout. Numbers right aligned in their own column.

**Two layouts for the Board, split at 640px** (`useNarrow`, `max-width:
39.99rem`). From 640px up it is the grid above; below, a week strip, the
picked day's menu panel and a list of everyone for that day, drawn from the
same cells. See [screens](screens.md#on-a-phone). No other screen has a second
layout: their content is already a column.

**Targets.** 44px each way on a phone, which is `Button`'s default and icon
size (`h-11`, `size-11`) and what every Board cell in the list is held to. The
grid, from 640px up, keeps its denser 36 to 40px cells, since a week of them has
to fit across.

The menu is a panel above the grid, not content inside the cells: a week of
people by days cannot also carry five days of dish lists, and it is what stops
the cell from having to say what you are about to order. Tapping a column head
moves the panel to that day.

## Interaction

Ordering is one tap in the common case, and the dialog only appears when there is
a genuine choice to make. A cell is an action and nothing else: what is on offer
is in the menu panel, so nobody has to tap a cell to find out what they got.

| Situation | Taps |
| --- | --- |
| Menu has one dish | 1 on `+`, the cell fills. No dialog, there is nothing to choose |
| Menu has several | 1 on the dice orders one at random, 1 on `+` opens the chooser |
| Inside the dialog | 1 on a dish, or 1 on **Surprise me** |
| Changing your mind | tap the cell, tap a different dish |
| Not eating | tap a filled cell, then **Not eating** |
| How you want it | a note under the dish, 120 characters, saved against that dish |

The dice appears only where there is something to randomise, which is the whole
rule rather than a special case. Both targets carry a label and a title, because
a phone has no hover and an unlabelled glyph is a puzzle.

There is no "eating but no dish chosen" limbo to fall into by accident. The old
flow created that state on every tick and then nagged about it. **Surprise me**
is a primary action in the dialog, not a fallback, because on most days nobody
cares which of three similar dishes they get.

**You pass a meal by tapping the person you are giving it to.** The board is
already a grid of people, so sending somebody to a dropdown to find a colleague
asks them to re-enter what the screen is showing. A colleague's cell opens a
sheet of sentences: `Give Tèo my Bún bò` for anybody, `Pass Tèo's Cơm gà to
someone` for an admin recording a swap between two other people, which is the one
case that still needs a picker. An empty colleague cell opens it too, because "I
am out, you have mine" is usually said to somebody who was not eating anyway.

Sentences rather than icons, deliberately. A cell is a person and a day, and a
tap on it could mean give or take: that is a difference of grammar, not of
appearance, and two arrows pointing the same way would need a legend to tell them
apart. There is no legend on this board and there should never be one.

An offer that has not been answered is legible on the board itself, as the
recipient's name on the cell it concerns, because an admin has no reason to open
a cell to discover something they cannot see.

**Which meals can still be passed on.** The old screen asked for orders from
today forward, so a Tuesday meal could not be handed over on Thursday even though
the database permits it. The rule is the database's: a meal can be passed until
its billing period closes, which `enforce_transfer_rules` enforces by refusing
anything already on a closed bill. So the board offers the whole **open billing
week**, not `today` onward. People remember on Thursday that Tuesday's lunch went
to somebody else, and the app has to let them say so, because the alternative is
that the bill is quietly wrong.

## Components

Tailwind plus shadcn/ui, which is Radix underneath. Components are copied into
the repo rather than imported from a runtime dependency, so they can be changed
and are not a vendor lock.

Used because the app genuinely needs them, not to fill a kit: `Dialog` (dish
picker, handover sheet, confirmations), `Sonner` (the one toast surface),
`Combobox` (the admin's recording form, the only place left where a person has to
be named rather than tapped), `Button`, `Badge`, `Table`, `Tooltip` (disabled
reasons), `Tabs`, `Skeleton`.

## The two hooks that make it systematic

```ts
// Every mutation. Pending state, success toast, error toast via humanError.
const publish = useAction(publishMenu, { success: "Published" });
await publish.run({ ... });

// Every control that can be unavailable. `reason` is null or the sentence shown.
<Action reason={cutoffPassed ? "Ordering closed at 21:00" : null} ... />
```

Nothing writes its own `try/catch/setError` again. That is what stops the seventh
screen from inventing an eighth way to report failure.
