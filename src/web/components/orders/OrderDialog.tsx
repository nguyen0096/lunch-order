import { useRef, useState, type ReactNode } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import {
  Action,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@/ui";
import type {
  BoardDay,
  CorrectionEntry,
  OrdersMember,
  PassAnswer,
  PassRecord,
  RecordedMeal,
} from "../../api.js";
import { PRICE_PENDING, formatMoney, parseVietnamesePrice, type Currency } from "../../../shared/money.js";
import { longDayLabel } from "../boardModel.js";
import { arrivedLabel } from "../payments/labels.js";
import { ReasonField } from "./ReasonField.js";
import {
  balanceNow,
  kindWord,
  mealPreview,
  mealWords,
  moveMealPreview,
  passSentence,
  provenanceSentence,
  removalPreview,
  type DayAccess,
} from "./model.js";

/** One person's meal as the admin is about to set it. */
export type MealCorrection = {
  /** Null when the dish was never on the menu and arrives with its own price. */
  menuItemId: number | null;
  dishName: string;
  /** Only read when `menuItemId` is null. */
  priceMinor: number | null;
  quantity: number;
  note: string | null;
  reason: string | null;
};

type Step = "edit" | "passed" | "remove" | "pass" | PassAnswer;

const OFF_MENU = "off-menu";
const NOTE_MAX = 120;
const MAX_PORTIONS = 20;
/** Above this many people the recipient list becomes a search. */
const LIST_MAX = 10;
const INPUT = "h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base";

/**
 * One person, one day, one save.
 *
 * A tap on a cell never writes; it opens this. Every write in it says in
 * figures what it would do to whose money, directly above the button that
 * does it, and the button names the person. Removing, passing and answering
 * an offer are each a second step, so the button that moves money is never
 * the first thing under a finger. The dialog is remounted per cell, so it
 * never carries the last cell's dish or note, and Enter in a field saves
 * nothing: there is no form to submit.
 */
export function OrderDialog({
  person,
  day,
  meal,
  pass,
  received,
  access,
  members,
  hasLunch,
  entries,
  timeZone,
  stage,
  over,
  currency,
  pending,
  error,
  onClose,
  onStep,
  onSave,
  onRemove,
  onPass,
  onUndo,
  onAnswer,
}: {
  person: OrdersMember;
  day: BoardDay;
  /** Null when nothing is recorded for this person on this day. */
  meal: RecordedMeal | null;
  /** The live pass on this meal, if any. */
  pass: PassRecord | null;
  /** Meals passed to this person on this day and accepted. */
  received: PassRecord[];
  access: Extract<DayAccess, { mode: "write" | "read" }>;
  members: OrdersMember[];
  hasLunch: (profileId: string) => boolean;
  /** The day's history. */
  entries: CorrectionEntry[];
  timeZone: string;
  /** `open until 21:00 Thu 1 Oct`, `Served`. */
  stage: string;
  /** The lunch has happened, so the record is history rather than a plan. */
  over: boolean;
  currency: Currency;
  pending: boolean;
  /** The database's own refusal, kept on screen while the dialog stays open. */
  error: string | null;
  onClose: () => void;
  /** A step changed, so an old refusal no longer applies. */
  onStep: () => void;
  onSave: (correction: MealCorrection) => void;
  onRemove: (reason: string | null) => void;
  onPass: (toProfileId: string, reason: string | null) => void;
  onUndo: (reason: string | null) => void;
  onAnswer: (answer: PassAnswer, reason: string | null) => void;
}) {
  const nameOf = (id: string) => members.find((m) => m.profileId === id)?.name ?? "A colleague";
  const balanceOf = (id: string) => members.find((m) => m.profileId === id)?.balanceMinor ?? 0;
  const readOnly = access.mode === "read";
  const passed = pass?.status === "accepted" ? pass : null;
  const offer = pass?.status === "pending" ? pass : null;
  const payer = passed ? { name: nameOf(passed.toProfileId), balanceMinor: balanceOf(passed.toProfileId) } : person;

  const [step, setStepRaw] = useState<Step>(passed ? "passed" : "edit");
  const setStep = (s: Step) => {
    onStep();
    setStepRaw(s);
  };

  const [picked, setPicked] = useState<string | null>(
    meal === null || meal.menuItemId === null ? null : String(meal.menuItemId),
  );
  const [offMenuName, setOffMenuName] = useState("");
  const [offMenuPrice, setOffMenuPrice] = useState("");
  const [quantity, setQuantity] = useState(meal === null || meal.quantity < 1 ? 1 : meal.quantity);
  const [note, setNote] = useState(meal?.note ?? "");
  const [reason, setReason] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const offMenu = picked === OFF_MENU;
  const dish = day.dishes.find((d) => String(d.id) === picked) ?? null;
  const read = parseVietnamesePrice(offMenuPrice);
  // The database reuses a dish of the same name on the day, ignoring case and
  // spacing. A priced match is saved as that dish, and the preview uses its
  // price, not the typed one. An unpriced match is refused: pricing it for one
  // person would leave everybody else's lines of it unpriced.
  const typed = dishKey(offMenuName);
  const sameName = offMenu && typed !== "" ? day.dishes.find((d) => dishKey(d.name) === typed) ?? null : null;
  const reused = sameName !== null && sameName.priceMinor !== null ? sameName : null;
  const unitMinor = offMenu
    ? reused?.priceMinor ?? read?.minor ?? null
    : dish?.priceMinor ?? null;
  const afterMinor = unitMinor === null ? null : unitMinor * quantity;
  const why = reason.trim() === "" ? null : reason.trim();
  const dishLabel = meal?.dishName ?? "meal";

  const unpricedMatch =
    sameName !== null && sameName.priceMinor === null
      ? `"${sameName.name}" is already on the menu with no price yet. Set its price with Reprice, then record this meal`
      : null;

  const problem =
    unpricedMatch ??
    (picked === null
      ? "Pick a dish first"
      : offMenu && offMenuName.trim() === ""
        ? "Give the dish a name"
        : offMenu && reused === null && read === null
          ? "Say what the dish cost"
          : null);

  function save() {
    if (problem !== null) return;
    onSave({
      menuItemId: reused?.id ?? (offMenu ? null : dish?.id ?? null),
      dishName: reused?.name ?? (offMenu ? offMenuName.trim() : dish?.name ?? ""),
      priceMinor: offMenu && reused === null ? read?.minor ?? null : null,
      quantity,
      note: note.trim() === "" ? null : note.trim(),
      reason: why,
    });
  }

  const provenance =
    meal === null ? null : provenanceSentence({ meal, entries, nameOf, timeZone });
  const dayLine = `${longDayLabel(day.serviceDate)} · ${stage}`;
  const warning =
    access.mode === "write" && access.warning !== null ? (
      <div role="note" className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
        <p className="font-medium">{access.warning.heading}</p>
        <p>
          The caterer may already have the count and be cooking. If this adds a portion, tell them
          yourself: the app will not.
        </p>
      </div>
    ) : null;
  const errorLine = error !== null && <p className="text-danger-subtle-fg">{error}</p>;

  let title: string;
  let description: string;
  let body: ReactNode;
  let footer: ReactNode;

  if (readOnly) {
    title = meal === null ? `${person.name}, ${longDayLabel(day.serviceDate)}` : `${person.name}'s ${dishLabel}`;
    description = dayLine;
    const mine = entries.filter((e) => e.profileId === person.profileId);
    body = (
      <>
        {meal === null ? (
          <p>{`${person.name} has nothing recorded.`}</p>
        ) : (
          <>
            <MealBlock meal={meal} currency={currency} />
            {meal.note !== null && <p className="wrap-anywhere">{`How they wanted it: ${meal.note}`}</p>}
            {provenance && <p className="text-muted">{provenance}</p>}
            {pass && <p>{passSentence({ pass, nameOf, timeZone })}</p>}
          </>
        )}
        {received.map((r) => (
          <p key={r.id}>{`${nameOf(r.fromProfileId)} passed their meal to ${person.name}, who pays for it.`}</p>
        ))}
        {mine.length > 0 && <History entries={mine} nameOf={nameOf} timeZone={timeZone} />}
      </>
    );
    footer = (
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
    );
  } else if (step === "passed" && passed && meal) {
    title = `${person.name}'s ${dishLabel}`;
    description = dayLine;
    body = (
      <>
        {warning}
        <MealBlock meal={meal} currency={currency} />
        <p>{passSentence({ pass: passed, nameOf, timeZone })}</p>
        <ReasonField value={reason} onChange={setReason} />
        <Preview note="Both of them get a message saying what you recorded.">
          {moveMealPreview({
            opening: "Undoing it would move",
            amountMinor: meal.amountMinor,
            from: payer,
            to: { name: person.name, balanceMinor: person.balanceMinor },
            back: true,
            currency,
          })}
        </Preview>
        {errorLine}
        <div className="flex flex-wrap gap-x-4">
          <QuietLink onClick={() => setStep("edit")}>Change this meal</QuietLink>
          <QuietLink onClick={() => setStep("remove")}>Remove this meal</QuietLink>
        </div>
      </>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Action reason={null} pending={pending} variant="outline" onClick={() => onUndo(why)}>
          {pending ? "Undoing…" : "Undo the pass"}
        </Action>
      </>
    );
  } else if (step === "remove" && meal) {
    title = `Remove ${person.name}'s meal`;
    description = dayLine;
    body = (
      <>
        {warning}
        <p>
          {over
            ? `The record says ${person.name} had ${mealWords(meal)}.`
            : `${person.name} is down for ${mealWords(meal)}.`}
        </p>
        <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
          {removalPreview({ name: payer.name, meal, balanceMinor: payer.balanceMinor, currency })}
        </p>
        <ReasonField value={reason} onChange={setReason} />
        {errorLine}
      </>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep(passed ? "passed" : "edit")}>
          Back
        </Button>
        <Action reason={null} pending={pending} variant="danger" onClick={() => onRemove(why)}>
          {pending ? "Removing…" : `Remove ${person.name}'s meal`}
        </Action>
      </>
    );
  } else if (step === "pass" && meal) {
    title = `Pass ${person.name}'s ${dishLabel}`;
    description = `${dayLine}. Whoever you pick pays for it instead of ${person.name}.`;
    const others = members.filter((m) => m.profileId !== person.profileId);
    const toName = to === null ? null : nameOf(to);
    body = (
      <>
        {warning}
        {others.length > LIST_MAX ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pass-to" className="text-xs font-medium text-subtle">
              To
            </label>
            <Combobox
              id="pass-to"
              aria-label="To"
              options={others.map((m) => ({
                value: m.profileId,
                label: `${m.name} · ${hasLunch(m.profileId) ? "has lunch that day" : "nothing that day"}`,
                keywords: [m.name],
              }))}
              value={to}
              placeholder="Pick who had it"
              searchPlaceholder="Search the office"
              emptyMessage="Nobody in the office matches that."
              onChange={setTo}
            />
          </div>
        ) : (
          <RadioList
            legend="To"
            name="pass-to"
            value={to}
            onChange={setTo}
            options={others.map((m) => ({
              value: m.profileId,
              label: m.name,
              aside: hasLunch(m.profileId) ? "has lunch that day" : "nothing that day",
            }))}
          />
        )}
        <ReasonField value={reason} onChange={setReason} />
        {to !== null && toName !== null && (
          <Preview note="Both of them get a message saying what you recorded.">
            {moveMealPreview({
              opening: "This would move",
              amountMinor: meal.amountMinor,
              from: person,
              to: { name: toName, balanceMinor: balanceOf(to) },
              currency,
            })}
          </Preview>
        )}
        {errorLine}
      </>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep("edit")}>
          Back
        </Button>
        <Action
          reason={to === null ? "Pick who had it first" : null}
          pending={pending}
          onClick={() => to !== null && onPass(to, why)}
        >
          {pending ? "Passing…" : toName === null ? "Pass" : `Pass to ${toName}`}
        </Action>
      </>
    );
  } else if ((step === "accept" || step === "decline" || step === "withdraw") && offer && meal) {
    const from = person.name;
    const recipient = nameOf(offer.toProfileId);
    const verb =
      step === "accept"
        ? `Accept for ${recipient}`
        : step === "decline"
          ? `Decline for ${recipient}`
          : `Withdraw ${from}'s offer`;
    title = step === "withdraw" ? `Withdraw ${from}'s offer` : `${step === "accept" ? "Accept" : "Decline"} ${from}'s offer for ${recipient}`;
    description = dayLine;
    body = (
      <>
        {warning}
        <p>{passSentence({ pass: offer, nameOf, timeZone })}</p>
        <ReasonField value={reason} onChange={setReason} />
        <Preview note="Both of them get a message saying what you recorded.">
          {step === "accept"
            ? moveMealPreview({
                opening: "This would move",
                amountMinor: meal.amountMinor,
                from: person,
                to: { name: recipient, balanceMinor: balanceOf(offer.toProfileId) },
                currency,
              })
            : `No money moves: ${from} keeps the meal and pays for it. ${from} ${balanceNow(person.balanceMinor, currency)}.`}
        </Preview>
        {errorLine}
      </>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep("edit")}>
          Back
        </Button>
        <Action reason={null} pending={pending} onClick={() => onAnswer(step, why)}>
          {pending ? "Saving…" : verb}
        </Action>
      </>
    );
  } else {
    title = meal === null ? `Add a meal for ${person.name}` : `Change ${person.name}'s meal`;
    description =
      meal === null ? `${dayLine}. ${person.name} has nothing recorded.` : `${dayLine}. ${provenance ?? ""}`.trim();
    const passReason =
      offer !== null ? "Answer or withdraw the offer first" : passed !== null ? "Undo the pass first" : null;
    body = (
      <>
        {warning}
        {received.map((r) => (
          <p key={r.id} className="text-muted">
            {`${person.name} also has ${nameOf(r.fromProfileId)}'s meal that day, passed to them.`}
          </p>
        ))}
        {passed && <p className="text-muted">{`${payer.name} pays for this meal now.`}</p>}
        <RadioList
          legend="Dish"
          name="dish"
          value={picked}
          onChange={setPicked}
          options={[
            ...day.dishes.map((d) => ({
              value: String(d.id),
              label: d.name,
              aside: d.priceMinor === null ? PRICE_PENDING : formatMoney(d.priceMinor, currency),
            })),
            { value: OFF_MENU, label: "A dish not on the menu", aside: null, quiet: true },
          ]}
        />

        {offMenu && (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Dish" htmlFor="off-menu-name">
              <input
                id="off-menu-name"
                value={offMenuName}
                onChange={(e) => setOffMenuName(e.target.value)}
                className={INPUT}
              />
            </Field>
            <Field label="What it cost" htmlFor="off-menu-price">
              <input
                id="off-menu-price"
                value={offMenuPrice}
                inputMode="numeric"
                onChange={(e) => setOffMenuPrice(e.target.value)}
                className={cn(INPUT, "tabular")}
              />
              {/* As the parser read it: 45k and 45.000 are the same keystrokes
                  read two ways, and the person has to see which was taken. */}
              {read !== null && <p className="tabular text-xs text-muted">{formatMoney(read.minor, currency)}</p>}
            </Field>
          </div>
        )}
        {sameName !== null && (
          <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
            {unpricedMatch !== null
              ? `${unpricedMatch}.`
              : `${sameName.name} is already on this day's menu at ${formatMoney(sameName.priceMinor ?? 0, currency)}. Saving records that dish at that price, whatever is typed here.`}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
          <Field label="Portions" htmlFor="portions">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="One portion fewer"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <MinusIcon />
              </Button>
              <output
                id="portions"
                aria-live="polite"
                className="flex h-11 w-14 items-center justify-center rounded-md border border-border bg-surface-raised text-base tabular"
              >
                {quantity}
              </output>
              <Button
                variant="outline"
                size="icon"
                aria-label="One portion more"
                disabled={quantity >= MAX_PORTIONS}
                onClick={() => setQuantity((q) => Math.min(MAX_PORTIONS, q + 1))}
              >
                <PlusIcon />
              </Button>
            </div>
          </Field>
          <Field label="Note for the caterer" htmlFor="order-note">
            <input
              id="order-note"
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>

        <ReasonField value={reason} onChange={setReason} />

        {picked !== null && unpricedMatch === null && (
          <Preview note={`${person.name} gets a message saying what you saved.`}>
            {mealPreview({
              name: payer.name,
              beforeMinor: meal?.amountMinor ?? null,
              hadMeal: meal !== null,
              afterMinor,
              balanceMinor: payer.balanceMinor,
              currency,
            })}
          </Preview>
        )}

        {errorLine}

        {offer && (
          <div className="flex flex-col gap-1 rounded-md border border-dashed border-accent px-3 py-2">
            <p>{passSentence({ pass: offer, nameOf, timeZone })}</p>
            <div className="flex flex-wrap gap-x-4">
              <QuietLink onClick={() => setStep("accept")}>{`Accept for ${nameOf(offer.toProfileId)}`}</QuietLink>
              <QuietLink onClick={() => setStep("decline")}>{`Decline for ${nameOf(offer.toProfileId)}`}</QuietLink>
              <QuietLink onClick={() => setStep("withdraw")}>{`Withdraw ${person.name}'s offer`}</QuietLink>
            </div>
          </div>
        )}

        {meal !== null && (
          <div className="flex flex-wrap gap-x-4">
            <QuietLink onClick={() => setStep("remove")}>Remove this meal</QuietLink>
            <QuietLink reason={passReason} onClick={() => setStep("pass")}>
              Pass this meal to someone
            </QuietLink>
            {passed && <QuietLink onClick={() => setStep("passed")}>Back to the pass</QuietLink>}
          </div>
        )}
      </>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Action reason={problem} pending={pending} onClick={save}>
          {pending ? "Saving…" : `Save ${person.name}'s meal`}
        </Action>
      </>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto"
        // The title, not the first radio, so a stray keypress changes nothing.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">{body}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ pieces */

/** The database's own match for a dish name: NFC, spacing folded, any case. */
function dishKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-subtle">
        {label}
      </label>
      {children}
    </div>
  );
}

/** The figures, worded as what would happen, directly above the button. */
function Preview({ children, note }: { children: ReactNode; note: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2 text-muted">
      <p>{children}</p>
      <p className="text-xs">{note}</p>
    </div>
  );
}

function MealBlock({ meal, currency }: { meal: RecordedMeal; currency: Currency }) {
  return (
    <div className="flex items-baseline justify-between gap-4 rounded-md bg-surface-sunken px-3 py-2">
      <span className="font-medium wrap-anywhere">{mealWords(meal)}</span>
      <span className="shrink-0 text-muted tabular">
        {meal.amountMinor === null ? PRICE_PENDING : formatMoney(meal.amountMinor, currency)}
      </span>
    </div>
  );
}

/** A step within the dialog: quiet, because the write is on the next screen. */
function QuietLink({
  children,
  onClick,
  reason = null,
}: {
  children: ReactNode;
  onClick: () => void;
  reason?: string | null;
}) {
  return (
    <Action reason={reason} variant="link" className="h-11 px-0" onClick={onClick}>
      {children}
    </Action>
  );
}

function RadioList({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: string | null;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; aside: string | null; quiet?: boolean }>;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="pb-1.5 text-xs font-medium text-subtle">{legend}</legend>
      <div className="flex flex-col overflow-hidden rounded-md border border-border">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={o.value}
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0",
                on ? "bg-accent-subtle text-accent-subtle-fg" : "hover:bg-surface-sunken",
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <input
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={on}
                  aria-label={o.aside === null ? o.label : `${o.label}, ${o.aside}`}
                  onChange={() => onChange(o.value)}
                  className="size-4 shrink-0 accent-[var(--accent)]"
                />
                <span className={cn("wrap-anywhere", o.quiet ? "text-muted" : "font-medium")}>{o.label}</span>
              </span>
              {o.aside !== null && (
                <span className={cn("shrink-0 text-xs tabular", !on && "text-muted")}>{o.aside}</span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function History({
  entries,
  nameOf,
  timeZone,
}: {
  entries: CorrectionEntry[];
  nameOf: (id: string) => string;
  timeZone: string;
}) {
  return (
    <ul className="flex flex-col border-t border-border">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0">
          <span>
            <span className="font-medium">{kindWord(e.kind)}</span>
            {` · ${e.summary}`}
          </span>
          <span className="text-xs text-subtle">{`${nameOf(e.madeBy)} · ${arrivedLabel(e.madeAt, timeZone)}`}</span>
          {e.reason !== null && <span className="text-muted">{`Why: ${e.reason}`}</span>}
        </li>
      ))}
    </ul>
  );
}
