# Fork extensions

This checkout is rebased semantically on upstream `v0.3.1` (`bfec7ac3a`). Fork behavior is kept
behind narrow, subsystem-owned seams so a future rebase can compare behavior instead of replaying
historical patches.

Protocol capabilities added by the fork are optional fields in `server_info.features`. Their
compatibility gates were retained on the `v0.3.1` fork baseline and have a review date of
2027-01-16. Removing a gate does not by itself remove the extension; remove an extension only
when the supported upstream behavior covers the acceptance criteria below.

| Extension                | Owner seam                                                                         | Capability / wire contract                                                                     | Persistence                                                                                           | Remove when upstream…                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Favorite model sync      | `use-favorite-models.ts` and server `AppPreferencesStore`                          | `favoriteModelsSync`; `preferences.favorite_models.{get,initialize,set}` plus `changed` status | Host `app-preferences.json`; local `FormPreferences` remains a one-time legacy seed / old-daemon mode | owns favorites on the host, synchronizes clients, and distinguishes missing state from an authoritative empty list                                |
| Provider usage warnings  | `ProviderUsageService.onFreshUsage()` and `ProviderUsageAlertMonitor`              | `providerUsageWarnings`; `provider.usage.alerts.changed`                                       | Host `provider-usage-alerts.json` stores dedupe/reset state                                           | emits 75/90/95% alerts for 5-hour and weekly windows with reset-safe dedupe and refresh scheduling                                                |
| Issue links              | daemon config `issueTrackers` and `createIssueAwareMarkdownParser()`               | `issueLinks`; existing daemon-config RPC carries optional tracker records                      | Host daemon config                                                                                    | supports configurable prefixes/templates in the shared Markdown renderer without rewriting code spans or existing links                           |
| Selectable diff base     | `CheckoutDiffCompare.baseRef` and `diff-pane.tsx`                                  | `checkoutDiffBaseSelection`; no new diff RPC                                                   | App panel store, schema version 13, per checkout                                                      | accepts an arbitrary compare base in the existing checkout diff API and exposes a picker                                                          |
| Native Codex commands    | `AgentSession.resolveCommand()`                                                    | No new wire capability; server-side provider seam with `tryHandleOutOfBand` fallback           | None                                                                                                  | resolves and executes Codex-native commands, including rewrite/handled results, attachments, active-turn validation, and unknown-command behavior |
| Retained plan cards      | central stream projection for app-only `permission_plan` items                     | No wire change                                                                                 | Reconstructed from the loaded permission-event timeline                                               | renders approved, rejected, and superseded plan permission events as durable timeline items                                                       |
| Composer prompt history  | pure composer history model plus `MessageInput.onKeyPress` / compact history sheet | No wire change                                                                                 | Derived from the loaded workspace stream                                                              | provides boundary-aware Up/Down prompt recall and a compact/mobile history surface                                                                |
| Workspace MRU navigation | keyboard action registry plus `WorkspaceNavigationHistoryStore`                    | No wire change                                                                                 | AsyncStorage key `paseo:workspace-navigation-history`                                                 | provides cross-host Ctrl-Tab MRU navigation with a frozen cycle until modifier release                                                            |
| Desktop/Sway attention   | preload `window.setAttention(boolean)` and `WindowAttentionManager`                | Electron IPC only                                                                              | None                                                                                                  | provides compositor-neutral window attention with correct focus, renderer-reset, multi-window, and Sway urgency semantics                         |
| Pi settled lifecycle     | Pi provider `agent_settled` handling                                               | Pi runtime event only                                                                          | None                                                                                                  | keeps user-visible turns active across automatic retry and overflow compaction                                                                    |

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
- Sidebar action parity uses the upstream shared menu engine; do not restore the fork action model.
- Prompt navigation uses the upstream server-backed Chat Outline; do not restore PromptNavigator.
- Completed-turn liveness uses the upstream submission lifecycle from PR #2484; do not restore the
  optimistic-row idle-loader fix.

## Rebase checklist

For each extension, first test the removal condition against the new upstream tag. If upstream
fully owns it, delete the fork slice and its tests. If upstream partially owns it, retain only the
missing behavior through the listed seam. Keep protocol additions optional and keep capability
detection at the owning boundary rather than scattering defensive fallbacks through the feature.
