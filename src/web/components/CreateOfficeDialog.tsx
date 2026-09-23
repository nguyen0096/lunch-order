/**
 * Creating an office.
 *
 * Its own file because two unrelated screens open it: the office switcher, for
 * somebody who already has one, and the sign-in screen, for somebody who
 * belongs nowhere yet. Living inside either of those would make the other
 * import a screen to get at a dialog.
 */

import { useEffect, useId, useState } from "react";
import {
  Action,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useAction,
} from "@/ui";
import { createOffice, officeProblem, suggestSlug } from "../api.js";
import type { Org } from "../../shared/types.js";

/* One spelling of a text input, matching the fields on Settings so two dialogs
   cannot be two heights. 16px minimum, or iOS Safari zooms the page on focus. */
const INPUT =
  "h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text placeholder:text-subtle";

/**
 * Founding an office: a name, and the address it will live at.
 *
 * The address is suggested from the name because a name is the only thing the
 * person actually knows at this point, and asking somebody to invent a URL
 * fragment before they have an office is how a two-field form loses half the
 * people who open it. It stays editable, and it stops following the name the
 * moment they touch it.
 *
 * `create_organization` makes the caller the owner in the same transaction, so
 * there is no membership to write here -- only a refetch, which is `onCreated`.
 */
export function CreateOfficeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (org: Org) => void;
}) {
  const nameId = useId();
  const slugId = useId();
  const [name, setName] = useState("");
  // null while the address still follows the name. An empty string is a person
  // who cleared the field, and must not silently refill.
  const [slug, setSlug] = useState<string | null>(null);
  const address = slug ?? suggestSlug(name);

  const create = useAction(createOffice, {
    success: (created) => `Created ${created.name}`,
    onSuccess: (created) => {
      onOpenChange(false);
      onCreated(created);
    },
  });
  const { reset } = create;

  // A dialog that reopens holding the last attempt is a dialog that founds the
  // wrong office on a stray Enter.
  useEffect(() => {
    if (!open) {
      setName("");
      setSlug(null);
      reset();
    }
  }, [open, reset]);

  const problem = officeProblem({ name, slug: address });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create an office</DialogTitle>
          <DialogDescription>
            You become its owner. Colleagues join with the code you get afterwards.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (problem !== null) return;
            void create.run({ name, slug: address });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">
              Office name
            </label>
            <input
              id={nameId}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Công ty Ăn Trưa"
              className={INPUT}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={slugId} className="text-sm font-medium">
              Web address
            </label>
            <input
              id={slugId}
              value={address}
              // Lowercased as it is typed, because `create_organization` will
              // lowercase it anyway and a field that shows one address while
              // creating another is a small lie.
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby={`${slugId}-hint`}
              className={INPUT}
            />
            <p id={`${slugId}-hint`} className="max-w-prose text-xs text-muted">
              {`The office lives at #/o/${address || "…"}/board, and the address is what colleagues paste into a chat. Suggested from the name; change it if you like.`}
            </p>
          </div>

          <p className="max-w-prose text-xs text-muted">
            Days and cutoffs run in Asia/Ho_Chi_Minh, and the bill is in dong.
          </p>

          {create.error && (
            // The toast has already said it once; the sentence stays here
            // because the dialog is where the field it concerns is.
            <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
              {create.error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Action reason={problem} pending={create.pending} type="submit">
              Create office
            </Action>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
