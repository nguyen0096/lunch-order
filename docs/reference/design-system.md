# Design system

The rules the interface is checked against. A screen that breaks one of these is
wrong even if it looks fine, because the cost of an inconsistency is paid by
every future screen, not this one.

## What this app is

A shared weekly board for an office lunch order. Vietnamese food, Vietnamese
names, prices in whole dong. Most people order from Telegram and never open this;
the web app is the desktop surface where an admin publishes a menu, sees the
week, and settles the bill.

That is the opposite of what the old CSS assumed (`mobile-first, one breakpoint`),
which is why the old one looked like a phone app stretched across a monitor.

## Non-negotiables

1. **No raw color, spacing or font size in a component.** Tokens only. A hex
   literal outside the token file is a bug.
2. **Every mutation reports.** One hook handles pending, success and failure, so
   no screen invents its own. An action that silently succeeds is a defect.
3. **Every disabled control carries its reason**, and the reason is visible, not
   just implied by the grey. A row of controls disabled with no explanation is
   what made the old People screen look broken when it was working.
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

**Two states, one hue.** Today and ordered both used the accent before, which made
each vaguer. Now: *ordered* is a filled accent cell, *today* is an accent rule on
the column edge. Fill versus stroke, not two colours.

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
┌──────────────────────────────────────────────────────┐
│  Test Office            Board   Me      Menu  People │
├──────────────────────────────────────────────────────┤
│  ‹  22–26 Sep                              This week ›│
│                                                       │
│           Mon 22   Tue 23│  Wed 24   Thu 25   Fri 26 │
│  Tèo        ●        ○   │    ●        ·        ·    │
│  Dinh       ●        ●   │    ○        ·        ·    │
│  Neyu       ·        ●   │    ●        ·        ·    │
│           ────────────── │ ─────────────────────────  │
│  Total      2        2   │    3        0        0    │
└──────────────────────────────────────────────────────┘
   ● ordered (filled)   ○ eating, no dish   · none
   │ today (column rule, not a colour change)
```

Left aligned throughout. Numbers right aligned in their own column.

## Interaction

Ordering is one tap in the common case, and the dialog only appears when there is
a genuine choice to make.

| Situation | Taps |
| --- | --- |
| Menu has one dish | 1, the cell fills |
| Menu has several | 1 opens the dish dialog |
| Inside the dialog | 1 on a dish, or 1 on **Surprise me** |
| Changing your mind | tap the cell, tap a different dish |
| Not eating | tap a filled cell to clear it |

There is no "eating but no dish chosen" limbo to fall into by accident. The old
flow created that state on every tick and then nagged about it. **Surprise me**
is a primary action in the dialog, not a fallback, because on most days nobody
cares which of three similar dishes they get.

Passing a meal to somebody is an action on the cell you are already looking at,
not a separate destination. Both directions, offering and accepting, appear where
the meal is.

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
picker, confirmations), `Sonner` (the one toast surface), `Combobox` (person
pickers that must not be a flat list of every day × person × dish), `Button`,
`Badge`, `Table`, `Tooltip` (disabled reasons), `Tabs`, `Skeleton`.

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
