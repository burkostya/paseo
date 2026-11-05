# Fork extensions

This checkout is based on upstream `v0.15.2` (`e896c05b09707e711a2324fcab7da84a0ae57291`).
Each row records behavior that release still lacks and the fork keeps.

| Extension                | Status in upstream `v0.15.2` and fork decision                                                         | Remove when upstream provides                                                                                             | Plugin API decision                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Shared diff comparison   | Use upstream All changes; keep host settings, workspace overrides, automatic base and shared counters. | Persistent project/workspace settings, compatible legacy projection, shared counters and the same automatic-base sources. | Keep local: no complete comparison settings seam.                           |
| Desktop/Sway attention   | Keep the desktop bridge and Sway urgency.                                                              | Equivalent desktop attention and Sway urgency.                                                                            | Keep local: desktop IPC and compositor integration are not plugin surfaces. |
| Workspace hierarchy      | Keep parent-child controls and subtree actions with upstream sorting and filters.                      | Parent-child workspaces, ordering, collapse and subtree archive/restore.                                                  | Keep local: hierarchy belongs to the daemon and workspace shell.            |
| Agent profile identity   | Keep launch-profile identity in session persistence and serialization.                                 | Profile identity survives create, restore, fork and session serialization.                                                | Keep local: identity spans app and daemon.                                  |
| Layered configuration    | Keep ordered `.conf.d` layers, tombstones and write ownership.                                         | Equivalent layered reads, deletion semantics and writes for all configuration fields.                                     | Keep local: daemon configuration is not a plugin surface.                   |
| Existing worktree import | Keep discovery and import of an existing worktree path.                                                | Existing-worktree discovery and import through the workspace lifecycle.                                                   | Keep local: project and workspace creation belong to daemon and app.        |
| Continue after error     | Keep the guarded composer action after a run error.                                                    | Equivalent continuation with pending and error states.                                                                    | Keep local: this is app run-state handling.                                 |
| Pi command rewind        | Keep command checkpoints and history projection.                                                       | Durable rewind boundaries for commands without user messages.                                                             | Keep local: provider identity and branch order belong to the Pi adapter.    |
| Replica-cache retry      | Keep single-flight persistence, delayed retries and guarded reads.                                     | Equivalent retry coordination, bounded retries and read safety.                                                           | Keep local: this is internal replica-cache lifecycle.                       |

## Retired from this fork

The composer prompt history and workspace MRU shortcuts were removed during the `v0.10.2` update.
Keep ordinary conversation history, workspace navigation, and last-workspace restoration.
Native Codex command catalog and routing are upstream-owned as of `v0.10.2`.
Plan cards use the upstream implementation from `v0.15.2` for evaluation.
Pi live reasoning grouping and overlap reconciliation are upstream-owned as of `v0.15.2`.

## Upstream-owned replacements

Use the upstream Codex command listing and routing; do not restore the fork command catalog or
dispatcher.

Use the upstream Nix runtime tracing for `node-pty`; do not restore the fork's hard-coded native-addon path.

Do not restore fork implementations for behaviors covered by upstream `v0.15.2`. Use the upstream
Markdown renderer, quota/usage service, workspace draft retention, agent reload flow, Pi command
discovery and ordinary execution, and settled compaction lifecycle. Keep upstream background
workspace filtering and the profile catalog.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
