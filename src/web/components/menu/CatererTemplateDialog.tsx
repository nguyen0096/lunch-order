import { useState } from "react";
import {
  Action,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useAction,
} from "@/ui";
import { setCatererTemplate } from "../../api.js";
import {
  CATERER_PLACEHOLDERS,
  DEFAULT_CATERER_TEMPLATE,
  catererMessage,
  catererTemplateProblem,
  type CatererOrder,
} from "../../../shared/catererOrder.js";

/**
 * The office's wording for the caterer's order, set once and reused every day.
 *
 * Previewed against the day on screen, so an admin sees their own dishes in it
 * rather than an invented example.
 */
export function CatererTemplateDialog({
  open,
  onOpenChange,
  orgId,
  companyName,
  order,
  template,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: number;
  companyName: string;
  order: CatererOrder;
  /** What is saved now. Null means the default. */
  template: string | null;
  onSaved: (template: string | null) => void;
}) {
  const current = template ?? DEFAULT_CATERER_TEMPLATE;
  const [value, setValue] = useState(current);
  const problem = catererTemplateProblem(value);

  // The default is stored as null, so an office that types it back is not
  // left pinned to today's wording if the default is ever improved.
  const stored = value === DEFAULT_CATERER_TEMPLATE ? null : value;

  const save = useAction(() => setCatererTemplate(orgId, stored), {
    success: "Saved",
    onSuccess: () => {
      onSaved(stored);
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto wrap-anywhere">
        <DialogHeader>
          <DialogTitle>The message template</DialogTitle>
          <DialogDescription>
            Used for every day&rsquo;s order to the caterer. The words in braces are filled in for
            you.
          </DialogDescription>
        </DialogHeader>

        <label htmlFor="caterer-template" className="sr-only">
          Template
        </label>
        <textarea
          id="caterer-template"
          value={value}
          rows={6}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="caterer-template-problem"
          className="w-full rounded-lg border border-border bg-surface-raised p-3 font-mono text-sm"
        />
        <p id="caterer-template-problem" className="text-sm text-danger-subtle-fg" aria-live="polite">
          {problem ?? ""}
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {CATERER_PLACEHOLDERS.map((p) => (
            <div key={p.key} className="contents">
              <dt>
                <code className="font-mono text-text">{`{${p.key}}`}</code>
              </dt>
              <dd className="text-muted">{p.means}</dd>
            </div>
          ))}
        </dl>

        {problem === null && (
          <section className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Preview for this day</h3>
            <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-sm whitespace-pre-wrap text-text">
              {catererMessage(order, { companyName, template: value })}
            </pre>
          </section>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Action
            variant="outline"
            reason={value === DEFAULT_CATERER_TEMPLATE ? "This is already the default wording" : null}
            onClick={() => setValue(DEFAULT_CATERER_TEMPLATE)}
          >
            Restore the default
          </Action>
          <Action
            reason={problem ?? (value === current ? "Nothing to save" : null)}
            pending={save.pending}
            onClick={() => void save.run()}
          >
            Save
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
