# Fork extensions

This checkout is based on upstream `v0.7.0` (`c56638ea8c2852d722a87e700abf3c966ded617e`). Fork behavior is kept
behind narrow, subsystem-owned seams so a future rebase can compare behavior instead of replaying
historical patches.

Protocol capabilities added by the fork are optional fields in `server_info.features`. Their
compatibility gates were retained on the `v0.7.0` fork baseline and have a review date of
2027-01-16. Removing a gate does not by itself remove the extension; remove an extension only
when the supported upstream behavior covers the acceptance criteria below.

| Extension                | Owner seam                                                                                        | Capability / wire contract                                                                   | Persistence                                                 | Remove when upstream…                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider usage warnings  | `ProviderUsageService.onFreshUsage()` and `ProviderUsageAlertMonitor`                             | `providerUsageWarnings`; `provider.usage.alerts.changed`                                     | Host `provider-usage-alerts.json` stores dedupe/reset state | emits 75/90/95% alerts for 5-hour and weekly windows with reset-safe dedupe and refresh scheduling                                                |
| Issue links              | daemon config `issueTrackers` and `createIssueAwareMarkdownParser()`                              | `issueLinks`; existing daemon-config RPC carries optional tracker records                    | Host daemon config                                          | supports configurable prefixes/templates in the shared Markdown renderer without rewriting code spans or existing links                           |
| Selectable diff base     | `CheckoutDiffCompare.baseRef`, `useWorkingDiff()`, and the Changes comparison toolbar             | `checkoutDiffBaseSelection`; no new diff RPC                                                 | App panel store, schema version 17, per checkout            | accepts an arbitrary compare base in the existing checkout diff API and exposes a persistent picker                                               |
| Native Codex commands    | `AgentSession.resolveCommand()` and `startAgentRun()`                                             | No new wire capability; provider resolver runs before out-of-band, steer, replace, and start | None                                                        | resolves and executes Codex-native commands, including rewrite/handled results, attachments, active-turn validation, and unknown-command behavior |
| Retained plan cards      | central stream projection for app-only `permission_plan` items                                    | No wire change                                                                               | Reconstructed from the loaded permission-event timeline     | renders approved, rejected, and superseded plan permission events as durable timeline items                                                       |
| Composer prompt history  | pure composer history model plus the IME-safe `MessageInput` key snapshot / compact history sheet | No wire change                                                                               | Derived from the loaded workspace stream                    | provides boundary-aware Up/Down prompt recall and a compact/mobile history surface                                                                |
| Workspace MRU navigation | keyboard action registry plus `WorkspaceNavigationHistoryStore`                                   | No wire change                                                                               | AsyncStorage key `paseo:workspace-navigation-history`       | provides cross-host Ctrl-Tab MRU navigation with a frozen cycle until modifier release                                                            |
| Desktop/Sway attention   | preload `window.setAttention(boolean)` and `WindowAttentionManager`                               | Electron IPC only                                                                            | None                                                        | provides compositor-neutral window attention with correct focus, renderer-reset, multi-window, and Sway urgency semantics                         |

## Upstream-owned replacements

Do not restore the old fork implementations for these behaviors:

- New Workspace draft retention uses the upstream singleton draft and migration introduced by
  upstream PR #2036.
- Agent chat scrolling uses the upstream native themed scrollbar; the deleted overlay scrollbar
  subsystem stays deleted.
- Link copying uses the browser context menu and Electron's `Copy Link Address`.
- Agent reload/re-entry uses the upstream Reload action with timeline epoch/cursor handling; do not
  restore `/reload`.
- Pi native commands use the upstream Pi implementation. The fork command-resolution seam exists
  for Codex and future providers, not as a second Pi path.
- Pi retry and overflow compaction lifecycle uses upstream's settled signal. Do not restore the
  fork's Pi lifecycle patch.
- Favorite model sync, sidebar action parity, prompt navigation, draft retention, and the idle
  timeline loader use their upstream implementations.

## Rebase checklist

For each extension, first test the removal condition against the new upstream tag. If upstream
fully owns it, delete the fork slice and its tests. If upstream partially owns it, retain only the
missing behavior through the listed seam. Keep protocol additions optional and keep capability
detection at the owning boundary rather than scattering defensive fallbacks through the feature.
