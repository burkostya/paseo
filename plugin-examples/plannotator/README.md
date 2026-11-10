# Plannotator Guided Review

Install **Plannotator 0.28.53** separately on the daemon PATH. Install this directory with `paseo plugin install /absolute/path/to/plugin-examples/plannotator` and enable it through your normal plugin setup. Rebuild this checkout's daemon and client together: comparison resolution requires the `vcsComparisonResolution` capability. The plugin does not install hooks or change agent configuration.

Use Electron with the daemon on the same computer. Open **Plannotator: Code review** in the original agent's Command Center. Feedback and Guide requests belong to that existing session, even when you switch tabs.

## First review

1. Select **Task commits** for committed changes. The panel resolves the workspace's effective comparison base, including project inheritance. Select a local ref if the base is ambiguous; this changes only the review form. **Workspace PR / MR** uses the attached forge request and its locally recorded remote head. Fetch missing or stale remote refs explicitly before reviewing. **Uncommitted changes** includes staged, unstaged and untracked files.
2. Open **Start review / configure Plannotator**. In Plannotator, open **Settings → Review → Auto-mark viewed** and turn it **off before reading changes**. Return to the panel and confirm that you disabled it. This is your acknowledgement, not an inspection of the browser setting. Repeat after clearing browser data. The cookie normally survives a port change with the same hostname and browser profile.
3. Choose **Guide from task agent**, or **Guide through Plannotator**, then **Guide → Generate** in its interface. The first sends a request to the original idle agent to produce a validated file for the saved patch. The second uses Plannotator's provider/model settings. Both Guides remain in its picker. Cancelling a pending request ignores its eventual output and does not stop the agent.
4. Read the Guide or use the full file list. Mark files and sections deliberately. Plannotator can mark a file viewed when all Guide sections containing it are checked; the two counters show this native behavior. Files outside a Guide remain visible in the full list and are listed in the panel.
5. Submit feedback in Plannotator. The plugin saves the exact text, comparison and SHA before sending to the original agent. Approval also sends a message; dismissal sends nothing. Sending to a busy agent uses Paseo's non-interrupting steering behavior. It does not create another session.

## Pause, restore and update

Closing the browser tab leaves the process alive. **Open review** returns to it. **Stop review** and plugin shutdown save available state and terminate only owned processes. Reopening starts a new localhost URL. Use Plannotator's **Restore draft** banner to restore comments and file marks. Guide section marks are restored by Plannotator itself.

Submitting feedback completes Plannotator's native draft. The sent text stays in the plugin's delivery history; draft counters describe the remaining native draft, not a completed-review certificate.

**Check for updates** resolves the current source without fetching or changing the saved patch. **Update changes** creates a new immutable revision, retaining viewed marks only for identical paths, change kinds and exact file diffs. Comments and Guides remain in the old revision, accessible through **Open saved revision**. New revisions need new Guides. An identical patch does not create a revision.

Data lives under `$PASEO_HOME/plugin-data/plannotator`, including immutable patches and per-revision Plannotator data directories. Reviews from different agents never share drafts or Guides. Legacy feedback is preserved with unknown revision metadata; update a legacy review before reopening it.

If delivery is **unknown**, inspect the original session before explicit retry: it may already contain the message. A message ID does not guarantee exactly-once delivery. Failed and uncertain deliveries retain their text. No automatic retry runs.

## Compatibility and verification

The engine adapter pins **0.28.53** because its HTTP endpoints belong to that version's UI, not a stable external SDK. It runs `review --json --patch-file` without a shell, with `PLANNOTATOR_REMOTE=0` and `PLANNOTATOR_BROWSER=none`. URL discovery uses `sessions --json` and the owned PID; final stdout must contain `{ decision, message }`. stderr is diagnostic only. The plugin never injects browser scripts or edits browser storage.

CLI children inherit the daemon's environment. If your Codex launcher requires a profile, set `CODEX_LAUNCHER_PROFILE` when starting that daemon; acceptance used `personal`. Setting it in a later terminal does not change an already running daemon. The plugin does not choose or rewrite your launcher profile.

Static patches return `available: false` from `/api/review-progress`. The adapter uses `/api/draft` for comments and file marks, `/api/guides` and saved Guide endpoints for section marks, and `guide import --guide ... --patch ...` for agent results. Native draft restoration requires the user's Restore action.

Run the targeted suite from the checkout:

```bash
npx tsgo -p plugin-examples/plannotator/tsconfig.json
npx vitest run plugin-examples/plannotator/server/contract.test.ts --bail=1
PASEO_PLANNOTATOR_CONTRACT=1 npx vitest run plugin-examples/plannotator/server/contract.test.ts --bail=1
```

The opt-in check uses the real installed CLI and a temporary Git repository, verifies persistence across a new localhost port, imports two Guides, and invokes no AI providers. It does not replace Electron acceptance of native Guide generation, browser settings, draft recovery and feedback in Paseo.

### Acceptance status

Verified on Linux with Plannotator 0.28.53 and an isolated daemon: committed changes with a clean worktree; manually disabled Auto-mark viewed remaining off across a new port; file and section marks; comments in the diff and Guide; closing browser tabs; plugin reload and native draft restoration; explicit snapshot update preserving only an unchanged file's mark; feedback appearing in the original existing agent session; two simultaneous reviews with separate recipients; visible CLI crash diagnostics and reopening; saved feedback after an unavailable recipient, followed by explicit retry after restoring that session. The concurrency and failure scenarios used Paseo's test provider.

Both AI paths also passed in Electron using Codex 0.166.0, GPT-6-Luna and the `personal` launcher profile. The existing task agent wrote its requested Guide file, which the plugin validated and imported. Native Plannotator generation produced a second Guide for the same revision. Both remained selectable after plugin reload on a new localhost port; native Restore recovered the comment and file marks, and the section mark survived. Send feedback reached the original real Codex session, which replied without changing task code. Reading either Guide before explicit marking left file and section progress unchanged.

Process isolation, CLI failures, delivery uncertainty and cancelled Guide results also have automated coverage. The repository's Electron 44.2.0 runtime was unavailable; the acceptance run used Electron 43.8.3.

Remote daemons, mobile clients, publishing forge comments and automatic merge/deploy are outside this integration.
