# Agent workflow

- Read `CLAUDE.md` before changing code; it is the authority on Todou's architecture and invariants.
- Start by checking `git status` and `git diff`. Preserve unrelated work already in the checkout.
- Use a focused `codex/<topic>` branch and avoid unrelated refactors or generated-file churn.
- Run the smallest relevant checks before handing work off. For cross-app changes, run `bun run check` and `bun run check:rust` when practical.
- The public `typecheck`, `test`, `test:watch`, `test:rust`, and `supabase:test` commands install locked dependencies automatically; do not bypass them with direct tool invocations.
- Keep dependency versions exact. Before adding or upgrading one, verify the release is at least 48 hours old.
- Use conventional commit messages: `type(scope): description`.
- Do not push, merge, or otherwise change remote GitHub state unless the user explicitly asks in the current task. Exception: when a feature is complete and verified, automatically push its focused branch and open a non-draft PR ready for Aman’s review.
- Use a draft PR only while work is incomplete, required validation is failing or not yet run, a material issue is unresolved, or Aman explicitly asks for a draft. Once those conditions clear, mark the PR ready for review before reporting completion; Aman has standing authorization for that mechanical transition.
- Keep the PR title and body current with validation evidence and remaining risks. If GitHub prevents a required ready-for-review transition, report the exact blocker rather than claiming completion. This does not authorize merging, deploying, commenting, approving, or changing unrelated GitHub settings.
