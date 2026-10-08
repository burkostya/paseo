# Fork extensions

This checkout is based on upstream `v0.11.1` (`ab10a6694ccf068959d1a6b67b6c915e21a9fe91`).
The retained fork behavior stays behind subsystem-owned seams so future rebases can compare
behavior instead of replaying historical patches.

| Extension                | Status in upstream `v0.11.1`                                                                                       | Decision                                                                                                           | Plugin API decision                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Shared diff comparison   | `baseRef` is accepted; project defaults, workspace overrides, and shared counters are missing                      | Keep host-persisted comparisons across Changes, sidebar, and composer until upstream owns the complete flow        | Keep local: no complete diff-toolbar or persistence seam                         |
| Retained plan cards      | Claude reports self-entered plan mode; durable outcome projection and reconciliation are missing                   | Keep reconciliation, deduplication, rejected outcomes, and Markdown copy until upstream retains the same outcomes  | Keep local: no plugin timeline projection seam                                   |
| Desktop/Sway attention   | Not present                                                                                                        | Keep the Electron attention bridge and Linux-gated Sway urgency handling                                           | Keep local: desktop IPC and compositor integration are not plugin surfaces       |
| Workspace hierarchy      | No matching parent-child workspace controls or subtree archive/restore flow                                        | Keep the hierarchy and its reviewed subtree actions                                                                | Keep local: hierarchy ownership belongs to the daemon and workspace shell        |
| Agent profile identity   | Profiles can configure agents and the last live mode survives resume; persisted launch-profile identity is missing | Keep profile identity and serialized config application while preserving upstream live-mode persistence            | Keep local: identity and config ownership span daemon and app                    |
| Layered configuration    | Provider defaults exist; ordered config fragments and their write ownership differ                                 | Keep layered reads and serialized writes until upstream supports the same ownership rules                          | Keep local: daemon configuration is not a plugin surface                         |
| Existing worktree import | New workspaces can use worktrees; the project-menu import flow is missing                                          | Keep discovery, selection, and import of existing worktrees until upstream owns the same flow                      | Keep local: project and workspace creation belong to the daemon and app          |
| Continue after error     | No matching one-action continuation flow                                                                           | Keep the composer action and its guarded continuation path                                                         | Keep local: the action is part of app run-state handling                         |
| Pi live reasoning        | Pi emits reasoning deltas; live client grouping is missing                                                         | Keep reasoning deltas together in the active timeline head                                                         | Keep local: live timeline grouping belongs to the client reducer                 |
| Pi command rewind        | Conversation rewind exists; commands without native user messages have no durable rewind boundary                  | Keep command checkpoints and their history projection, preserving upstream custom-message visibility and tool rows | Keep local: provider identities and native branch order belong to the Pi adapter |
| Replica-cache retry      | Pending writes are restored and retried; retry/read concurrency guarantees differ                                  | Keep retry scheduling, single in-flight persistence, and guarded read flushing                                     | Keep local: this is internal daemon cache lifecycle                              |

## Retired from this fork

The composer prompt history and workspace MRU shortcuts were removed during the `v0.10.2` update.
Keep ordinary conversation history, workspace navigation, and last-workspace restoration.
Native Codex command catalog and routing are upstream-owned as of `v0.10.2`.

## Upstream-owned replacements

Use the upstream Codex command listing and routing; do not restore the fork command catalog or
dispatcher.

Use the upstream Nix runtime tracing for `node-pty`; do not restore the fork's hard-coded native-addon path.

Do not restore fork implementations for behaviors covered by upstream `v0.11.1`. In particular,
use the upstream Markdown renderer, quota/usage service, workspace draft retention, agent reload
flow, Pi command discovery and ordinary execution, and settled compaction lifecycle.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
