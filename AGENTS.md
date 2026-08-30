# Repository Instructions

## Git and commits

- Use Conventional Commits in the form `type(scope): summary`.
- Keep the subject concise, specific, and written as an imperative action.
- Use a meaningful lowercase scope when one is helpful, such as `project`, `realtime`, `transcript`, `auth`, or `deploy`.
- Prefer a one-line commit message for routine, focused changes.
- Add a commit body only for major features, substantial behavior changes, significant fixes, or changes spanning several important concerns.
- Separate the subject and body with one blank line.
- In a body, explain the intent, user-visible or architectural impact, important contracts, and non-obvious tradeoffs. Do not repeat a file-by-file change list.
- Stage and commit only files that belong to the current task. Preserve unrelated user changes.
- Review the staged diff and run relevant checks before committing.
- Create, amend, squash, or rewrite commits only when the user explicitly asks.

Routine example:

```text
docs(project): define VoxBraid MVP architecture
```

Substantial-change example:

```text
feat(dashboard): derive compact asset-performance wire

Project the full ledger response into a versioned Dashboard v1 read model,
retaining completeness and consistency metadata while removing per-fill detail.
Lock the Python and TypeScript contract with a shared golden fixture.
```
