# Workflow: how a task reaches production

Every task, however small, goes through the same four stages in order. A task
is not done until stage 4 is done.

1. **Implement** on its own branch, never on `main`.
2. **Update the docs** as part of the same change, done by whoever implemented
   it. See [documentation.md](documentation.md).
3. **QA** by a separate reviewer (a fresh agent), not the implementer. See
   [qa.md](qa.md). Confirmed findings go back to the implementer, and the fix
   round is QA'd again if it changes behaviour.
4. **Push** only after QA passes and the owner has approved pushing. See
   [deployment.md](deployment.md).

## Rules that apply throughout

- **Nobody but the coordinator pushes.** Implementers and reviewers commit on
  their branch and stop.
- **Owner decisions are not assumed.** When a choice changes product behaviour,
  ask the owner with a recommendation, and record the answer
  ([documentation.md](documentation.md)).
- **Production data is read-only** except for an explicit owner request, and
  then only the rows named.
- **Commit often on long tasks,** so an interrupted agent loses nothing.

## Clean up when finished

Every agent removes what it created before it reports back, and says in its
report what it removed and what it deliberately kept.

| What it created | When it goes |
| --- | --- |
| Servers, watchers, background processes, database sessions | before reporting |
| Scratch databases and scratch git worktrees (e.g. a merge check) | before reporting |
| Temporary symlinks, stashes, uncommitted edits in someone else's tree | before reporting |
| Its branch worktree and local branch | once the branch is merged or abandoned; the coordinator removes it after the push |

Nothing is left half-running for the next agent to trip over.
