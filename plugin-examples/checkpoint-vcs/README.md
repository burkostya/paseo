# Checkpoint VCS example

This external plugin keeps checkpoints of `note.txt` in a directory marked with
`.paseo-checkpoints`. It uses the public VCS server and client APIs, runs in a plugin
subprocess, and needs no Git or jj executable.

From the Paseo checkout, with a development daemon already running and
**Settings → Plugins → Enable plugins** turned on for that host:

```bash
npm run cli -- plugin install "$PWD/plugin-examples/checkpoint-vcs"
node plugin-examples/checkpoint-vcs/init.mjs /tmp/paseo-checkpoint-demo
```

Choose a new directory for the initializer. Open that directory as a workspace on
the same host. In Changes, inspect the added `note.txt`, choose **Create checkpoint**,
enter a description, and save. Edit the file in the editor or terminal; Changes
updates through the host's observation service. History shows saved checkpoints
and their parents. Select a history row to inspect its diff.

Open **Checkpoint details** from the view selector, workspace menu, or Command
Center. The panel and action use English or Russian according to the app locale.
Disable and enable the plugin to verify that history survives and contributions
follow the installation lifetime.

Only `note.txt` is versioned. Other files are ignored by this example. The example
accepts small text files, up to 16,384 characters, and stores at most 32 checkpoints.
From a saved history revision, create an isolated workspace using the standard
workspace action. The copy starts at that checkpoint and keeps its ancestor
history; unsaved edits and unrelated files are not copied. Each copy has its own
history file and retains the source repository identity across plugin reloads.

If workspace setup fails, rollback removes only an unchanged copy created by this
plugin. Extra files, edits, or symbolic links leave the copy available for manual
cleanup. Like checkpoint writes, cleanup assumes no concurrent external writer.
Archive and restore isolated copies through the normal workspace lifecycle.
Recovery preserves the entire checkpoint history, unsaved edits (including deletion
of `note.txt`), empty directories. The host retains each workspace's exact `cwd` separately from
the shared recovery data, so another workspace referencing the same copy can restore
it. After that restore, reopening the other workspaces validates the live copy's
identity and retains newer edits; it does not require the released recovery data.
The host persists this bounded recovery envelope before deleting the directory, so recovery
survives plugin and daemon restarts without temporary refs or a separate backup
store. Restoring to an occupied path never overwrites its contents; move a partial
or unrelated directory aside before retrying. Extra files and symbolic links block
archive cleanup. The initializer's original directory cannot be removed by this API.
The example allows at most 128 directories per copy and omits refs, remotes and
publication. Use Git or jj for projects that need those features.

Working diffs and paginated history refer to a bounded in-memory snapshot cache.
After eviction or plugin reload, refresh Changes; an expired comparison fails
instead of silently reading newer file contents. Saved revision diffs remain
available across reloads. Checkpoint creation validates input and rechecks file
state before writing history atomically. This example assumes one daemon owns
its history file; atomic replacement does not coordinate independent writers.

See the [VCS API reference](../../public-docs/plugins/reference.md#vcs-providers)
and [client contributions](../../public-docs/plugins/reference.md#vcs-client-contributions)
for contracts and optional capability groups. Keep plugin code on public
`@getpaseo/plugin` entry points; no app or daemon imports are needed.
