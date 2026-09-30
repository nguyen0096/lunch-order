# Documentation: where things are written down

Every owner decision is recorded, in the one place a reader would look for it.
The docs follow Diataxis ([docs/README.md](../../docs/README.md)); keep them
lean and add a new file only when no existing page is the right home.

| What | Where |
| --- | --- |
| How ordering, menus, standing days, billing behave | `docs/reference/ordering-rules.md` |
| What a screen shows and does, per state | `docs/reference/screens.md` |
| Database invariants, lock order, test files | `docs/reference/database.md` |
| Tokens, type, layout, target sizes | `docs/reference/design-system.md` |
| Secrets and where they live | `docs/reference/secrets.md` |
| A procedure someone follows by hand | `docs/how-to/` |
| Why a design is the way it is | `docs/explanation/`, or `docs/decisions.md` for a single decision's rationale |
| Work not started | `docs/backlog.md` |

## Rules

- **`decisions.md` holds rationale only.** Not every decision belongs there; a
  rule goes to the reference page that states it.
- **Update, do not append.** Rewrite the sentence that became false rather than
  adding a correction below it.
- **Code is the source of truth.** Where a doc and the code disagree, trust the
  code and fix the doc.
