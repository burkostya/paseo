# Plannotator Guided Review

Install **Plannotator 0.28.53-paseo.1** from the fleet package, or upstream **0.28.53**, separately on the daemon PATH. Install this directory with `paseo plugin install /absolute/path/to/plugin-examples/plannotator` and enable it through your normal plugin setup. Rebuild this checkout's daemon and client together: comparison resolution requires the `vcsComparisonResolution` capability. The plugin does not install hooks or change agent configuration.

Use Electron with the daemon on the same computer. Open **Plannotator: Code review** in the original agent's Command Center. Feedback and Guide requests belong to that existing session, even when you switch tabs.

## First review

1. Select **Task commits** for committed changes. The panel resolves the workspace's effective comparison base, including project inheritance. Select a local ref if the base is ambiguous; this changes only the review form. **Workspace PR / MR** uses the attached forge request and its locally recorded remote head. Fetch missing or stale remote refs explicitly before reviewing. **Uncommitted changes** includes staged, unstaged and untracked files.
2. Open **Start review / configure Plannotator**. In Plannotator, open **Settings → Review → Auto-mark viewed** and turn it **off before reading changes**. Return to the panel and confirm that you disabled it. This is your acknowledgement, not an inspection of the browser setting. Disable it once per browser profile and hostname; repeat after clearing browser data or changing profiles. The cookie survives a localhost port change. This is not a per-review step.
3. Choose a Guide generator:
   - **Guide from task agent** asks the original idle session to write a validated file for the saved patch. It uses that session's model. Cancellation ignores the eventual file without stopping task work.
   - **Guide from separate agent** uses the profile, provider and model selected in the panel. A profile supplies launch defaults; you can override its model. The helper reads the saved request and patch files, runs in the original workspace, and is archived after its turn ends. Cancellation stops only that request's helper. Permission requests still require your decision. The original agent and feedback recipient stay unchanged. This mode requires the updated Paseo host SDK; reloading the plugin alone cannot update an old daemon SDK.
   - **Guide through Plannotator** opens its interface; choose **Guide → Generate** and select the engine and model there.

   All Guides remain in the picker. If a generated file failed to import, use **Retry import saved Guide** to validate and import it without requesting another generation. A failed or interrupted helper is not recreated automatically.

4. Read the Guide or use the full file list. Mark files and sections deliberately. Plannotator can mark a file viewed when all Guide sections containing it are checked; the two counters show this native behavior. Files outside a Guide remain visible in the full list and are listed in the panel.
5. Submit feedback in Plannotator. The plugin saves the exact text, comparison and SHA before sending to the original agent. Approval also sends a message; dismissal sends nothing. Sending to a busy agent uses Paseo's non-interrupting steering behavior. It does not create another session.

## Pause, restore and update

Closing the browser tab leaves the process alive. **Open review** returns to it. **Stop review** and plugin shutdown save available state and terminate only owned processes. Reopening starts a new localhost URL. Use Plannotator's **Restore draft** banner to restore comments and file marks. Guide section marks are restored by Plannotator itself.

Submitting feedback completes Plannotator's native draft. The sent text stays in the plugin's delivery history; draft counters describe the remaining native draft, not a completed-review certificate.

**Check for updates** resolves the current source without fetching or changing the saved patch. **Update changes** creates a new immutable revision, retaining viewed marks only for identical paths, change kinds and exact file diffs. Comments and Guides remain in the old revision, accessible through **Open saved revision**. New revisions need new Guides. An identical patch does not create a revision.

Data lives under `$PASEO_HOME/plugin-data/plannotator`, including immutable patches and per-revision Plannotator data directories. Reviews from different agents never share drafts or Guides. Legacy feedback is preserved with unknown revision metadata; update a legacy review before reopening it.

If delivery is **unknown**, inspect the original session before explicit retry: it may already contain the message. A message ID does not guarantee exactly-once delivery. Failed and uncertain deliveries retain their text. No automatic retry runs.

## Compatibility and verification

The engine adapter accepts **0.28.53** and **0.28.53-paseo.1** because its HTTP endpoints belong to that version's UI, not a stable external SDK. It runs `review --json --patch-file` without a shell, with `PLANNOTATOR_REMOTE=0` and `PLANNOTATOR_BROWSER=none`. URL discovery uses `sessions --json` and the owned PID; final stdout must contain `{ decision, message }`. stderr is diagnostic only. The plugin never injects browser scripts or edits browser storage.

CLI children inherit the daemon's environment. If your Codex launcher requires a profile, set `CODEX_LAUNCHER_PROFILE` when starting that daemon; acceptance used `personal`. Setting it in a later terminal does not change an already running daemon. The plugin does not choose or rewrite your launcher profile. A Guide agent profile selects Paseo launch settings; it does not set `CODEX_LAUNCHER_PROFILE`.

The fleet package **0.28.53-paseo.1** retains the upstream HTTP contract and sends native Pi (Linux) and Codex prompts through stdin. Upstream 0.28.53 can fail with Linux `E2BIG` on large diffs. Existing review processes must be stopped and reopened to use an updated CLI. Provider context and input limits still apply: Codex 0.166.0 rejects native prompts above 1,048,576 characters. Use an agent file-based Guide mode for larger patches; the plugin does not truncate changes or silently choose another model.

Static patches return `available: false` from `/api/review-progress`. The adapter uses `/api/draft` for comments and file marks, `/api/guides` and saved Guide endpoints for section marks, and `guide import --guide ... --patch ...` for agent results. Native draft restoration requires the user's Restore action.

Static-patch sessions use a directory-based Guide shelf even when launched inside a Git repository. The adapter disables Git discovery for the import subprocess to use that same shelf, and verifies the ID returned by the CLI against the live review. Looking for a newly added list entry also confuses concurrent native generation with the imported Guide.

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

The separate-agent path also passed in isolated Electron: the task kept GPT-6-Luna while a helper using the Guide QA profile and an overridden GPT-6.1 Terra model wrote a valid Guide, which was imported before the helper was archived. Cancellation archived only the owned helper and left its task agent unchanged. Native Pi with llama-nixos/Qwen3.8-Flash-Next-UD-Q4_K_XL-Strata and Codex with GPT-6-Luna each generated a saved Guide in Electron from a synthetic patch above 192 KiB. The 1.65 MB transport test reached the providers without E2BIG: Codex rejected its character limit, and the local Pi model returned malformed output. These errors remained visible without terminating the review server. The fixed CLI contract suite also passed against 0.28.53-paseo.1, including import inside a Git repository with an origin remote.

Process isolation, helper reconciliation after uncertain creation, CLI failures, delivery uncertainty and cancelled Guide results also have automated coverage. The repository's Electron 44.2.0 runtime was unavailable; the acceptance run used Electron 43.8.3.

Remote daemons, mobile clients, publishing forge comments and automatic merge/deploy are outside this integration.
