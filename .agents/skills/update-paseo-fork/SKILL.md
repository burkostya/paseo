---
name: update-paseo-fork
description: Audit and rebase the maintained Paseo fork onto a newer upstream tag. Use when the user asks to update, sync, or pull Paseo from upstream, or invokes /update-paseo-fork. Do not use for beta or stable releases.
---

# Update the Paseo fork

Update the maintained fork by comparing behavior against the new upstream tag and rebasing only the extensions that upstream still lacks. Treat `docs/fork-extensions.md` as the source of truth for extension ownership and removal conditions.

## Ground the update

Read these before changing tracked files:

- `docs/fork-extensions.md`
- `docs/protocol-compatibility.md`
- `docs/testing.md`
- `docs/release.md` to keep an upstream update separate from a release

Inspect the worktree, branch and remotes. Preserve unrelated tracked changes and all untracked files. Never restart the main Paseo daemon.

Resolve and record:

- the current upstream base from `docs/fork-extensions.md`;
- the requested upstream tag and its exact commit;
- the fork commits after the current base;
- the local branch, its tracking ref, and the tracking ref's current remote SHA;
- upstream changes to versions, lockfiles, licensing, protocol, and each extension's owner seam.

Fetch metadata when needed, but do not mutate the branch until the audit and any required user decisions are complete. A changed upstream license requires explicit user approval.

## Audit before rebasing

Test every removal condition in `docs/fork-extensions.md` against the new upstream tag. Inspect both the upstream diff and the implementation at the new tag; matching names or nearby features are not proof of equivalent behavior.

Classify each extension:

- **Fully upstream-owned:** remove the fork implementation and its fork-only tests.
- **Partially upstream-owned:** keep only the missing behavior, adapted to upstream's current architecture.
- **Absent upstream:** retain the extension through its documented owner seam.

Also inspect the **Upstream-owned replacements** list. Do not restore those deleted fork paths during conflict resolution. Present the audit and call out choices that materially change scope, licensing, or externally visible behavior before mutation. If the request is audit-only, stop here.

## Rebase and integrate

Use the exact commit behind the selected upstream tag. Rebase the maintained fork commits onto it; do not merge the upstream branch into the fork. Refuse to overwrite unrelated work or guess which dirty changes may be discarded.

Resolve conflicts by taking upstream's current structure first, then restoring only behavior justified by the audit. In particular:

- keep optional fork protocol fields optional and wire schemas pure;
- gate a feature once at its owning boundary through `server_info.features`;
- tag compatibility shims with `COMPAT(...)` according to `docs/protocol-compatibility.md`;
- use dotted, direction-suffixed names for any new RPC pair;
- preserve upstream versions and license metadata from the selected tag unless the approved update requires a deliberate follow-up;
- avoid incidental `package-lock.json` churn caused only by the local npm version or dependency installation.

Update `docs/fork-extensions.md` in place with the new tag and exact commit. Remove rows whose acceptance criteria are fully upstream-owned, revise partial seams and removal conditions, and keep the upstream-owned replacement list current. Do not duplicate the extension inventory elsewhere.

## Verify the result

Choose focused tests from the changed behavior and the retained extension contracts. Never run the full local test suite.

When declarations can cross workspace boundaries, run the relevant owning builds first:

1. `npm run build:client` for protocol/client declarations.
2. `npm run build:server` when server or CLI declarations are involved.

Then run:

- the affected Vitest files with `npx vitest run <files> --bail=1`;
- `npm run typecheck`;
- `npm run lint`;
- `npm run format:check`;
- `git diff --check` and a diff against the new upstream tag.

Confirm that the new tag is the branch base, every retained extension remains represented, fully upstream-owned paths did not return, protocol additions remain backward-compatible, and the lockfile has no unrelated changes. Report any failing check with enough evidence to distinguish a fork regression from an upstream or environment failure.

Run `npm run format` before committing, then repeat any checks affected by formatting. Keep the resulting fork commits reviewable; do not fold unrelated user changes into them.

## Push boundary

An update request does not authorize a push. Before any push, report the resolved base, resulting fork commits, verification results, known failures, and the expected remote SHA recorded before rewriting history.

Push only after a separate explicit user request. For a rewritten branch, use an explicit `--force-with-lease=<remote-ref>:<expected-sha>` and verify the remote ref afterward. Stop if the lease no longer matches; never replace it with an unconditional force push.
