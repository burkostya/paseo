# Fork feature ledger (`v0.1.109` baseline)

The implementation and removal contracts for retained features live in
[`docs/fork-extensions.md`](../../../docs/fork-extensions.md).

| Original request                    | Ownership after semantic rebase                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Prompt history with Up/Down         | Fork extension: composer history model and compact history sheet                         |
| Preserve New Workspace draft        | Upstream: singleton draft from #2036; fork patch dropped                                 |
| Synchronize favorite models         | Fork extension: host-owned preferences with legacy local seed                            |
| Prompt marker navigator             | Fork extension: `StreamViewportHandle.scrollToItem`                                      |
| Reveal chat scrollbar on hover      | Upstream replacement: native themed scrollbar; fork overlay dropped                      |
| Provider usage limit warnings       | Fork extension: fresh-usage monitor and threshold alerts                                 |
| Matching kebab/context actions      | Fork extension: shared `SidebarRowAction[]` model                                        |
| Keep plan card after resolve/reject | Fork extension: app-only `permission_plan` stream item                                   |
| Link configured issue IDs           | Fork extension: host config and shared Markdown plugin                                   |
| Copy chat link URL                  | Upstream/browser/Electron context menu; fork menu dropped                                |
| Sway workspace attention            | Fork extension: compositor-neutral bridge plus Sway adapter                              |
| Reload/re-enter agent               | Upstream Reload action; fork `/reload` dropped                                           |
| Ctrl-Tab                            | Fork extension: cross-host frozen-cycle MRU                                              |
| Provider-native slash commands      | Partial upstream: Pi retained upstream; fork extension only for Codex command resolution |
| Select diff base branch             | Partial upstream: existing `baseRef` API plus fork capability and picker                 |
