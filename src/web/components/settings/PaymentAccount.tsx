import { useState } from "react";
import { Action, Badge, Combobox, useAction } from "@/ui";
import { Section, TextField } from "./Section.js";
import { setPaymentConfig } from "../../api.js";
import {
  BANKS,
  bankByBin,
  isAccountNumber,
  normalizeAccountNumber,
} from "../../../shared/banks.js";
import type { PaymentConfig } from "../../../shared/payment.js";

type Draft = {
  bankBin: string | null;
  accountNumber: string;
  accountName: string;
  note: string;
};

function toDraft(config: PaymentConfig): Draft {
  return {
    bankBin: config.vietqr?.bankBin ?? null,
    accountNumber: config.vietqr?.accountNumber ?? "",
    accountName: config.vietqr?.accountName ?? "",
    note: config.note ?? "",
  };
}

function toConfig(draft: Draft): PaymentConfig {
  const accountNumber = normalizeAccountNumber(draft.accountNumber);
  const note = draft.note.trim();
  return {
    vietqr:
      draft.bankBin !== null && accountNumber !== ""
        ? {
            bankBin: draft.bankBin,
            accountNumber,
            accountName: draft.accountName.trim(),
          }
        : null,
    note: note === "" ? null : note,
  };
}

const same = (a: Draft, b: Draft) =>
  a.bankBin === b.bankBin &&
  normalizeAccountNumber(a.accountNumber) === normalizeAccountNumber(b.accountNumber) &&
  a.accountName.trim() === b.accountName.trim() &&
  a.note.trim() === b.note.trim();

const TITLE = "Where the money goes";
const DESCRIPTION = "The bank account behind the QR code on everyone's bill.";

/**
 * guard_owner_only_settings() refuses a payment_config change from anyone but
 * an owner. Recased from the sentence it raises, the way LeaveAndDelete recases
 * leave_office()'s: a refusal the screen predicts is written for the screen,
 * and only a refusal that actually came back travels through humanError().
 */
const OWNER_ONLY = "Only an owner can change where the money goes.";

/**
 * The account every bill's QR code pays, to whoever is allowed to change it.
 *
 * A non-owner admin still reads bills and chases payments, so they get the
 * account as facts rather than as a form: an editable field they would be
 * refused on save is a worse lie than a read-only one. Split in two so the
 * form's state and its save action exist only where they can be used.
 */
export function PaymentAccount({
  orgId,
  owner,
  initial,
  onSaved,
}: {
  orgId: number;
  /** `role === "owner"`. Admin is not enough for this one setting. */
  owner: boolean;
  initial: PaymentConfig;
  onSaved: () => void;
}) {
  return owner ? (
    <PaymentAccountForm orgId={orgId} initial={initial} onSaved={onSaved} />
  ) : (
    <PaymentAccountReadOnly config={initial} />
  );
}

/**
 * The bank is picked from a list rather than typed, because what the QR
 * actually carries is the bank's NAPAS BIN: a mistyped six-digit number is a
 * code that scans perfectly and pays a stranger, and nothing downstream would
 * notice. The account number and the name under it are then read back as one
 * sentence, which is the only check there is before somebody scans it.
 */
function PaymentAccountForm({
  orgId,
  initial,
  onSaved,
}: {
  orgId: number;
  initial: PaymentConfig;
  onSaved: () => void;
}) {
  // The last thing known to be in the database. Held here rather than re-read
  // from props so "Nothing to save" is true the moment a save lands, without a
  // refetch having to come back first.
  const [saved, setSaved] = useState(() => toDraft(initial));
  const [draft, setDraft] = useState(saved);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = useAction(
    async (next: Draft) => {
      await setPaymentConfig(orgId, toConfig(next));
      return next;
    },
    {
      success: "Saved",
      onSuccess: (next) => {
        setSaved(next);
        onSaved();
      },
    },
  );

  const account = normalizeAccountNumber(draft.accountNumber);
  const bank = bankByBin(draft.bankBin);
  const half = (draft.bankBin !== null) !== (account !== "");

  const reason =
    same(draft, saved)
      ? "Nothing to save"
      : half && draft.bankBin === null
        ? "Choose the bank this account is at"
        : half
          ? "Add the account number"
          : account !== "" && !isAccountNumber(account)
            ? "An account number is 4 to 19 letters or digits"
            : account !== "" && draft.accountName.trim() === ""
              ? "Add the account name, so people can check it before they pay"
              : null;

  return (
    <Section
      title={TITLE}
      description={`${DESCRIPTION} Leave it empty and the bill shows the amount without a code.`}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="bank" className="text-sm font-medium">
          Bank
        </label>
        <Combobox
          id="bank"
          value={draft.bankBin}
          onChange={(bin) => set("bankBin", bin)}
          options={BANKS.map((b) => ({
            value: b.bin,
            label: b.shortName,
            keywords: [b.fullName, b.bin, ...(b.aka ?? [])],
          }))}
          placeholder="Choose a bank"
          searchPlaceholder="Search banks"
          emptyMessage="No bank by that name. Try the short name, like Vietcombank."
          aria-label="Bank"
        />
      </div>

      <TextField
        id="account-number"
        label="Account number"
        value={draft.accountNumber}
        onChange={(v) => set("accountNumber", v)}
        placeholder="0123456789"
        inputMode="numeric"
        maxLength={32}
      />

      <TextField
        id="account-name"
        label="Account name"
        hint="Shown to whoever is paying before they confirm, so a wrong account gets caught."
        value={draft.accountName}
        onChange={(v) => set("accountName", v)}
        placeholder="NGUYEN VAN A"
        maxLength={80}
      />

      <TextField
        id="payment-note"
        label="Note under the QR"
        hint="Optional. Anything the payer should know: “pay Chi in cash if you prefer”."
        value={draft.note}
        onChange={(v) => set("note", v)}
        placeholder="Pay Chi in cash if you prefer"
        maxLength={200}
      />

      {/* The one check that exists before somebody scans it, so it is a
          sentence in the reading order rather than a hint beside a field. */}
      <p className="max-w-prose text-sm text-muted">
        {bank !== null && account !== "" ? (
          <>
            The QR will pay{" "}
            <strong className="text-text">
              {bank.shortName} {account}
            </strong>
            {draft.accountName.trim() !== "" && (
              <>
                , held by <strong className="text-text">{draft.accountName.trim()}</strong>
              </>
            )}
            . Check it against a statement before you save.
          </>
        ) : (
          "No account set yet, so bills show the amount and no QR code."
        )}
      </p>

      <div>
        <Action reason={reason} pending={save.pending} onClick={() => void save.run(draft)}>
          {save.pending ? "Saving" : "Save"}
        </Action>
      </div>
    </Section>
  );
}

/**
 * The same account, to an admin who is not an owner.
 *
 * They need to know it: they read bills and chase payments, so hiding it would
 * cost them the answer to "which account is this office paid into". They do not
 * get a form, because a form they can fill in and not save is a refusal held
 * back until after the typing. The control they came for is still here, saying
 * why it is not theirs, which is what the rest of this app does with an
 * unavailable action.
 */
function PaymentAccountReadOnly({ config }: { config: PaymentConfig }) {
  const account = config.vietqr;
  const bank = bankByBin(account?.bankBin ?? null);

  return (
    <Section title={TITLE} description={DESCRIPTION} aside={<Badge>Owner only</Badge>}>
      {account === null ? (
        <p className="max-w-prose text-sm text-muted">
          No account set yet, so bills show the amount and no QR code.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Bank</dt>
          <dd className="text-text">{bank?.shortName ?? account.bankBin}</dd>
          {account.accountName !== "" && (
            <>
              <dt className="text-muted">Account name</dt>
              <dd className="text-text">{account.accountName}</dd>
            </>
          )}
          <dt className="text-muted">Account number</dt>
          <dd className="tabular text-text">{account.accountNumber}</dd>
        </dl>
      )}

      {config.note !== null && (
        <p className="max-w-prose text-sm text-muted">{config.note}</p>
      )}

      <p className="max-w-prose text-sm text-muted">
        {`${OWNER_ONLY} When ordering closes and where the bot posts are still yours to set.`}
      </p>

      <div>
        <Action reason={OWNER_ONLY}>Change the account</Action>
      </div>
    </Section>
  );
}
