# Agent workflow

- Read `CLAUDE.md` before changing code; it is the authority on Todou's architecture and invariants.
- Start by checking `git status` and `git diff`. Preserve unrelated work already in the checkout.
- Use a focused `codex/<topic>` branch and avoid unrelated refactors or generated-file churn.
- Run the smallest relevant checks before handing work off. For cross-app changes, run `bun run check` and `bun run check:rust` when practical.
- Keep dependency versions exact. Before adding or upgrading one, verify the release is at least 48 hours old.
- Use conventional commit messages: `type(scope): description`.
- Do not push, create a pull request, merge, or change remote GitHub state unless the user explicitly asks in the current task.
- When a small feature is complete and verified, automatically open a draft pull request and return its link in the same success turn.
