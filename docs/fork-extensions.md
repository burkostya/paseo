# Fork extensions

This checkout is based on upstream `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`).
The retained fork behavior stays behind subsystem-owned seams so future rebases can compare
behavior instead of replaying historical patches.

| Extension              | Status in upstream `v0.10.2`                                                                | Decision                                                                    | Plugin API decision                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Selectable diff base   | `baseRef` is accepted by the diff API; the picker and per-workspace persistence are missing | Keep the picker and workspace-scoped selection, adapted to the upstream API | Keep local: no complete diff-toolbar or persistence seam                   |
| Retained plan cards    | Permission events exist; durable outcome projection and reconciliation are missing          | Keep reconciliation, deduplication, rejected outcomes, and Markdown copy    | Keep local: no plugin timeline projection seam                             |
| Desktop/Sway attention | Not present                                                                                 | Keep the Electron attention bridge and Linux-gated Sway urgency handling    | Keep local: desktop IPC and compositor integration are not plugin surfaces |
| Workspace hierarchy    | No matching parent-child workspace controls or subtree archive/restore flow                 | Keep the hierarchy and its reviewed subtree actions                         | Keep local: hierarchy ownership belongs to the daemon and workspace shell  |
| Agent profile identity | Profiles can configure agents; persisted launch-profile identity and layered config differ  | Keep profile identity and serialized config application                     | Keep local: identity and config ownership span daemon and app              |
| Continue after error   | No matching one-action continuation flow                                                    | Keep the composer action and its guarded continuation path                  | Keep local: the action is part of app run-state handling                   |
| Pi live reasoning      | No matching live reasoning-chunk projection                                                 | Keep streaming Pi reasoning chunks                                          | Keep local: this adapts provider events at the server boundary             |
| Replica-cache retry    | Read-through caching exists; retry after persistence failure is missing                     | Keep delayed persistence retry and read flushing                            | Keep local: this is internal daemon cache lifecycle                        |

## Retired from this fork

The composer prompt history and workspace MRU shortcuts were removed during the `v0.10.2` update.
Keep ordinary conversation history, workspace navigation, and last-workspace restoration.
Native Codex command catalog and routing are upstream-owned as of `v0.10.2`.

## Upstream-owned replacements

Use the upstream Codex command listing and routing; do not restore the fork command catalog or
dispatcher.

Do not restore fork implementations for behaviors covered by upstream `v0.10.2`. In particular,
use the upstream Markdown renderer, quota/usage service, workspace draft retention, agent reload
flow, Pi command handling, and settled compaction lifecycle.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
