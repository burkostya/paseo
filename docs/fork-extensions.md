# Fork extensions

This checkout is based on upstream `v0.9.1` (`81865852011df86aa0ad0ae411cb2f5e4078153f`).
The retained fork behavior stays behind subsystem-owned seams so future rebases can compare
behavior instead of replaying historical patches.

The plugin API does not expose a complete host seam for any retained extension. Keep these
features in the fork; do not add partial plugin wrappers or new protocol hooks just to move code.

| Extension                | Status in upstream `v0.9.1`                                                                | Decision                                                               | Plugin API decision                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Selectable diff base     | `baseRef` is accepted by the diff API; the picker and per-checkout persistence are missing | Keep the picker and persistent state, adapting to the upstream API     | Keep local: no complete diff-toolbar or persistence seam                   |
| Native Codex commands    | Not present                                                                                | Keep the Codex resolver and native command lifecycle                   | Keep local: provider command lifecycle is not a plugin surface             |
| Retained plan cards      | Permission events exist; durable approved/rejected/skipped projection is missing           | Keep the app projection and Codex/Claude plan outcome records          | Keep local: no plugin timeline projection seam                             |
| Composer prompt history  | Not present                                                                                | Keep the history model, keyboard navigation, and compact history sheet | Keep local: composer state is not a plugin surface                         |
| Workspace MRU navigation | Not present                                                                                | Keep the cross-host MRU store and keyboard action                      | Keep local: navigation state is owned by the app shell                     |
| Desktop/Sway attention   | Not present                                                                                | Keep the Electron attention bridge and Sway urgency handling           | Keep local: desktop IPC and compositor integration are not plugin surfaces |

## Upstream-owned replacements

Do not restore fork implementations for behaviors now covered by upstream `v0.9.1`. In particular,
use the upstream Markdown renderer, quota/usage service, workspace draft retention, agent reload
flow, Pi command handling, and settled compaction lifecycle.

## Rebase checklist

For each extension, test the upstream status before removing or replaying code. Keep protocol
changes backward-compatible, and keep capability detection at the owning boundary when a feature
needs a newer host.
