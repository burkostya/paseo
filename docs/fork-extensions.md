# Fork extensions

This checkout is based on upstream `v0.13.2` (`d2941157a8f91512daf54fc688241d416e8f5ebd`).
Each row records behavior that release still lacks and the fork keeps.

| Extension                | Status in upstream `v0.13.2` and fork decision                                                         | Remove when upstream provides                                                                                             | Plugin API decision                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Shared diff comparison   | Use upstream All changes; keep host settings, workspace overrides, automatic base and shared counters. | Persistent project/workspace settings, compatible legacy projection, shared counters and the same automatic-base sources. | Keep local: no complete comparison settings seam.                           |
| Retained plan cards      | Keep cross-source reconciliation, skipped outcomes and copying on the upstream card.                   | Equivalent reconciliation, skipped outcomes and full-plan copy.                                                           | Keep local: plugins have no durable permission projection seam.             |
| Desktop/Sway attention   | Keep the desktop bridge and Sway urgency.                                                              | Equivalent desktop attention and Sway urgency.                                                                            | Keep local: desktop IPC and compositor integration are not plugin surfaces. |
| Workspace hierarchy      | Keep parent-child controls and subtree actions with upstream sorting and filters.                      | Parent-child workspaces, ordering, collapse and subtree archive/restore.                                                  | Keep local: hierarchy belongs to the daemon and workspace shell.            |
| Agent profile identity   | Keep launch-profile identity in session persistence and serialization.                                 | Profile identity survives create, restore, fork and session serialization.                                                | Keep local: identity spans app and daemon.                                  |
| Layered configuration    | Keep ordered `.conf.d` layers, tombstones and write ownership.                                         | Equivalent layered reads, deletion semantics and writes for all configuration fields.                                     | Keep local: daemon configuration is not a plugin surface.                   |
| Existing worktree import | Keep discovery and import of an existing worktree path.                                                | Existing-worktree discovery and import through the workspace lifecycle.                                                   | Keep local: project and workspace creation belong to daemon and app.        |
| Continue after error     | Keep the guarded composer action after a run error.                                                    | Equivalent continuation with pending and error states.                                                                    | Keep local: this is app run-state handling.                                 |
| Pi live reasoning        | Keep live-chunk grouping and upstream overlap reconciliation.                                          | Equivalent grouping and reconciliation of live reasoning.                                                                 | Keep local: live timeline grouping belongs to the client reducer.           |
| Pi command rewind        | Keep command checkpoints and history projection.                                                       | Durable rewind boundaries for commands without user messages.                                                             | Keep local: provider identity and branch order belong to the Pi adapter.    |
| Replica-cache retry      | Keep single-flight persistence, backoff and guarded reads.                                             | Equivalent retry coordination, backoff and read safety.                                                                   | Keep local: this is internal replica-cache lifecycle.                       |

## Retired from this fork

The composer prompt history and workspace MRU shortcuts were removed during the `v0.10.2` update.
Keep ordinary conversation history, workspace navigation, and last-workspace restoration.
Native Codex command catalog and routing are upstream-owned as of `v0.10.2`.

## Upstream-owned replacements

Use the upstream Codex command listing and routing; do not restore the fork command catalog or
dispatcher.

Use the upstream Nix runtime tracing for `node-pty`; do not restore the fork's hard-coded native-addon path.

Do not restore fork implementations for behaviors covered by upstream `v0.13.2`. Use the upstream
Markdown renderer, quota/usage service, workspace draft retention, agent reload flow, Pi command
discovery and ordinary execution, and settled compaction lifecycle. Keep upstream background
workspace filtering and the profile catalog.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
