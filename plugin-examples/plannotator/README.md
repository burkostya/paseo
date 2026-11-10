# Plannotator code review

Install this directory with `paseo plugin install /absolute/path/to/plugin-examples/plannotator` and enable it using your normal plugin setup. Install the Plannotator binary separately on the daemon PATH. This plugin does not install agent hooks.

Use Electron with a daemon on the same computer. Open **Plannotator: Code review** in the agent Command Center, then **Review changes**. The existing workspace browser displays Plannotator. Submit feedback there to send its rendered message to the original agent. Approval also sends a message; dismissal sends nothing.

Closing the browser tab keeps the review alive. Reopen or cancel it from the agent panel. Disabling the plugin terminates its review processes. Saved results live under `$PASEO_HOME/plugin-data/plannotator` (default `~/.paseo`). A delivery interrupted by restart is uncertain: inspect the agent before retrying to avoid duplicate messages.

Verified CLI contract: **Plannotator 0.28.53**. Review uses `--json --git --diff-type uncommitted --no-git-remote-check`, `PLANNOTATOR_REMOTE=0`, and `PLANNOTATOR_BROWSER=none`. Session discovery matches PID through `sessions --json`; final stdout contains `{ decision, message }`. stderr is diagnostic only. The UI and its Git actions are provided by Plannotator.

Remote daemons, mobile, plan approval and automatic agent hooks are outside this version. Do not open this panel against a remote daemon: browser localhost belongs to the desktop.
