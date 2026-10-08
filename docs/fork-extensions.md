# Fork extensions

This checkout is based on upstream `v0.12.0` (`cafe4b01c8522ff39560241c5deb01427dc8dc5b`).
Each row records behavior that release still lacks and the fork keeps.

| Extension                | Status in upstream `v0.12.0`                                                                                          | Decision                                                                                                | Plugin API decision                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Shared diff comparison   | `baseRef` works; host-persisted defaults, workspace overrides, and shared counters are missing                        | Keep comparison settings and daemon snapshots; merge them with upstream review feedback                 | Keep local: no complete comparison settings seam                           |
| Retained plan cards      | Plan cards and standard outcomes exist; cross-source reconciliation, skipped outcomes, and full-plan copy are missing | Keep permission/timeline deduplication, outcome projection, and copy on the upstream card               | Keep local: plugins have no durable permission projection seam             |
| Desktop/Sway attention   | No Sway urgency or desktop attention bridge                                                                           | Keep Electron attention and Linux Sway urgency handling                                                 | Keep local: desktop IPC and compositor integration are not plugin surfaces |
| Workspace hierarchy      | Background workspaces are supported; parent-child controls and subtree archive/restore are missing                    | Keep hierarchy and subtree actions; preserve upstream background fields and filters                     | Keep local: hierarchy belongs to daemon and workspace shell                |
| Agent profile identity   | The app has a profile catalog; agent sessions do not persist the selected launch profile                              | Keep profile identity in app/server persistence and config serialization; protocol fields stay optional | Keep local: identity spans app and daemon                                  |
| Layered configuration    | Persisted config exists; ordered `.conf.d` fragments and their write ownership are missing                            | Keep layered reads, tombstones, snapshots, and serialized writes                                        | Keep local: daemon configuration is not a plugin surface                   |
| Existing worktree import | Worktrees can be created and listed; importing an existing path is missing                                            | Keep project-menu discovery, selection, and import                                                      | Keep local: project and workspace creation belong to daemon and app        |
| Continue after error     | Timeline sync retry exists; the composer has no guarded continue action after a run error                             | Keep the composer action and its guarded continuation path                                              | Keep local: this is app run-state handling                                 |
| Pi live reasoning        | Pi reasoning streams; non-authoritative chunks are not grouped into one live thought                                  | Keep chunk grouping and regression coverage; preserve upstream overlap reconciliation                   | Keep local: live timeline grouping belongs to the client reducer           |
| Pi command rewind        | Native conversation rewind exists; commands without user messages have no durable rewind boundary                     | Keep command checkpoints and history projection alongside native rewind                                 | Keep local: provider identity and branch order belong to the Pi adapter    |
| Replica-cache retry      | Active reads are invalidated and failed writes are retried; single-flight retry throttling differs                    | Keep shared in-flight persistence, delayed retry, backoff, and guarded reads                            | Keep local: this is internal replica-cache lifecycle                       |

## Retired from this fork

The composer prompt history and workspace MRU shortcuts were removed during the `v0.10.2` update.
Keep ordinary conversation history, workspace navigation, and last-workspace restoration.
Native Codex command catalog and routing are upstream-owned as of `v0.10.2`.

## Upstream-owned replacements

Use the upstream Codex command listing and routing; do not restore the fork command catalog or
dispatcher.

Use the upstream Nix runtime tracing for `node-pty`; do not restore the fork's hard-coded native-addon path.

Do not restore fork implementations for behaviors covered by upstream `v0.12.0`. Use the upstream
Markdown renderer, quota/usage service, workspace draft retention, agent reload flow, Pi command
discovery and ordinary execution, and settled compaction lifecycle. Keep upstream background
workspace filtering and the profile catalog.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
