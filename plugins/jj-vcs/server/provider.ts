import { classifyJjError } from "./errors.js";
import { jjSavedComparisonSettings } from "../shared/comparison.js";
import { workingCopyOptions } from "../shared/working-copy.js";
import { jjComparisonData } from "../shared/comparison.js";
import { revision, actionInput, actionIds, rewritingActions } from "../shared/actions.js";
import { createJjRecovery } from "./recovery.js";
import { stat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import {
  VcsError,
  createGitPublication,
  listGitIgnoredFiles,
  listUnpreservedFiles,
  fingerprintVcsPaths,
  gitObservationIgnoredDirectories,
  type VcsContext,
  type VcsExecutionContext,
  type VcsProviderRegistration,
} from "@getpaseo/plugin/server/vcs";
import { VcsRefSchema, type VcsRevision, type VcsBinding } from "@getpaseo/plugin";
import { z } from "zod";

const createdCopy = z.object({
  version: z.literal(1),
  data: z.object({ initialRevision: revision }),
});
const revisionSchema = z.object({
  commit_id: z.string(),
  change_id: z.string(),
  parents: z.array(z.string()),
  description: z.string(),
  author: z.object({ name: z.string(), email: z.string(), timestamp: z.string() }),
});
const refSchema = z.object({
  name: z.string(),
  remote: z.string().optional(),
  target: z.array(z.string()).optional(),
  tracking_target: z.array(z.string()).optional(),
});
const fileSchema = z.object({ path: z.string(), status: z.string(), conflict: z.boolean() });
const jsonLines = <T>(output: string, schema: z.ZodType<T>): T[] =>
  output.trim()
    ? output
        .trim()
        .split("\n")
        .map((line) => schema.parse(JSON.parse(line)))
    : [];

async function run(
  cwd: string,
  args: string[],
  context: VcsContext,
  read = false,
): Promise<string> {
  try {
    const result = await execCommand(
      "jj",
      [
        "--no-pager",
        "--color=never",
        "--config",
        "snapshot.auto-update-stale=false",
        ...(read ? ["--ignore-working-copy"] : []),
        ...args,
      ],
      {
        cwd,
        shell: false,
        signal: context.signal,
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          JJ_EDITOR: "false",
          JJ_DIFF_EDITOR: "false",
          JJ_MERGE_EDITOR: "false",
        },
      },
    );
    return result.stdout;
  } catch (error) {
    throw classifyJjError(error, args, context.signal);
  }
}
async function rootAt(cwd: string): Promise<string | null> {
  let root = path.resolve(cwd);
  while (true) {
    try {
      if ((await stat(path.join(root, ".jj"))).isDirectory()) return root;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
function toRevision(value: z.infer<typeof revisionSchema>): VcsRevision {
  return {
    id: value.commit_id,
    changeId: value.change_id,
    parents: value.parents,
    description: value.description,
    author: { name: value.author.name, email: value.author.email },
    timestamp: value.author.timestamp,
    conflict: false,
  };
}
async function history(
  binding: VcsBinding,
  revset: string,
  limit: number,
  context: VcsContext,
  operation?: string,
) {
  const output = await run(
    binding.root,
    [
      ...(operation ? ["--at-op", operation] : []),
      "log",
      "--no-graph",
      "-r",
      revset,
      "-n",
      String(limit),
      "-T",
      'json(self) ++ "\\t" ++ json(conflict) ++ "\\n"',
    ],
    context,
    true,
  );
  if (!output.trim()) return [];
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const [data, conflict] = line.split("\t");
      const result = toRevision(revisionSchema.parse(JSON.parse(data!)));
      result.conflict = z.boolean().parse(JSON.parse(conflict!));
      return result;
    });
}

async function validateFileSelection(
  binding: VcsBinding,
  input: z.infer<typeof actionInput>,
  context: VcsExecutionContext,
): Promise<void> {
  if (input.action !== "squash" && input.action !== "split") return;
  const paths = new Set(
    jsonLines(
      await run(
        binding.root,
        [
          "--at-op",
          context.snapshot.version,
          "diff",
          "-r",
          input.revision,
          "-T",
          'json(source.path()) ++ "\\n" ++ json(target.path()) ++ "\\n"',
        ],
        context,
        true,
      ),
      z.string(),
    ),
  );
  if (input.files.some((file) => !paths.has(file)))
    throw new VcsError({
      code: "outdated",
      message: "Selected files are not changed in the source revision; refresh the selection",
    });
}

export const jjProvider: VcsProviderRegistration = {
  async validateComparisonSettings(_binding, value) {
    return jjSavedComparisonSettings.parse(value);
  },
  id: "jj",
  publication: createGitPublication({
    async git(binding, args, context) {
      const directory = (await run(binding.root, ["git", "root"], context, true)).trim();
      try {
        return (
          await execCommand("git", ["--git-dir", directory, ...args], {
            cwd: binding.root,
            signal: context.signal,
            timeout: 30_000,
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
          })
        ).stdout;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new VcsError({
            code: "unavailable",
            message: "Git is required for jj remote discovery and verification",
          });
        throw error;
      }
    },
    head(snapshot, refName) {
      const ref = snapshot.refs.find((item) => item.name === refName && !item.remote);
      if (!ref || ref.targets.length !== 1)
        throw new VcsError({
          code: "outdated",
          message: "Select an existing, unambiguous local bookmark",
        });
      return ref.targets[0]!;
    },
    async canArchive(_binding, target, snapshot) {
      if (snapshot.state !== "ready" || !snapshot.current || snapshot.current.conflict)
        return false;
      if (snapshot.current.id === target.headRevision) return true;
      return (
        snapshot.files.length === 0 &&
        !snapshot.current.description.trim() &&
        snapshot.current.parents.length === 1 &&
        snapshot.current.parents[0] === target.headRevision
      );
    },
    async push(binding, target, snapshot, context) {
      await run(
        binding.root,
        [
          "--at-op",
          snapshot.version,
          "git",
          "push",
          "--remote",
          `exact:${JSON.stringify(target.remote)}`,
          "--bookmark",
          `exact:${JSON.stringify(target.headRef)}`,
        ],
        context,
        true,
      );
    },
  }),
  label: "Jujutsu",
  detectionPriority: 10,
  async localFiles(binding, query, context) {
    const trackedFiles = jsonLines(
      await run(
        binding.root,
        ["--at-op", "@", "file", "list", "-T", 'json(path) ++ "\\n"'],
        context,
        true,
      ),
      z.string(),
    );
    if (query.kind === "tracked") return trackedFiles;
    const gitDirectory = (await run(binding.root, ["git", "root"], context, true)).trim();
    return listGitIgnoredFiles({
      cwd: binding.root,
      gitDirectory,
      trackedFiles,
      patterns: query.patterns,
      signal: context.signal,
    });
  },
  workingCopies: {
    recovery: createJjRecovery({ provider: () => jjProvider, run }),
    async create(binding, input, context) {
      const options = input.data === undefined ? undefined : workingCopyOptions.parse(input.data);
      const name = options?.data.name ?? input.name;
      revision.parse(input.revision);
      if (!path.isAbsolute(input.root) || path.resolve(input.root) === binding.root)
        throw new Error("Invalid working copy destination");
      await run(
        binding.root,
        [
          "workspace",
          "add",
          "--no-colocate",
          "--name",
          name,
          "--revision",
          input.revision,
          "--",
          input.root,
        ],
        context,
      );
      const copyBinding = {
        ...binding,
        workingCopyId: input.root,
        root: input.root,
        cwd: input.root,
      };
      const initial = (await history(copyBinding, "@", 1, context))[0];
      if (!initial) throw new Error("Created jj workspace has no revision; directory retained");
      return {
        binding: copyBinding,
        owned: true,
        data: { version: 1, data: { initialRevision: initial.id } },
      };
    },
    async rollback(_source, record, context) {
      const initial = createdCopy.parse(record.data).data.initialRevision;
      // Refresh catches unsnapshotted edits; the saved commit also catches external jj rewrites.
      await run(record.binding.root, ["status"], context);
      const current = (await history(record.binding, "@", 1, context))[0];
      if (current?.id !== initial)
        throw new VcsError({
          code: "outdated",
          message: "Working copy changed after creation; directory retained",
        });
      const tracked = jsonLines(
        await run(
          record.binding.root,
          ["file", "list", "-T", 'json(path) ++ "\\n"'],
          context,
          true,
        ),
        z.string(),
      );
      const unsaved = await listUnpreservedFiles({
        root: record.binding.root,
        tracked,
        metadata: [".jj"],
        signal: context.signal,
      });
      if (unsaved.length)
        throw new VcsError({
          code: "conflict",
          message: `Directory retained: files outside the initial jj snapshot: ${unsaved.join(", ")}`,
        });
      context.signal.throwIfAborted();
      // Forget from the new copy itself so a caller cannot substitute another workspace name.
      await run(record.binding.root, ["workspace", "forget"], context, true);
      await rm(record.binding.root, { recursive: true });
    },
  },
  async detect(cwd, context) {
    const root = await rootAt(cwd);
    if (!root) return { status: "absent" };
    try {
      const version = (await run(root, ["--version"], context, true)).match(
        /jj (\d+)\.(\d+)\.(\d+)/,
      );
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 46)) {
        return {
          status: "unavailable",
          error: { code: "unsupported-version", message: "Jujutsu 0.46.0 or newer is required" },
        };
      }
      const repoPath = path.join(root, ".jj", "repo");
      const repositoryId = (await stat(repoPath)).isDirectory()
        ? await realpath(repoPath)
        : await realpath(
            path.resolve(path.dirname(repoPath), (await readFile(repoPath, "utf8")).trim()),
          );
      return {
        status: "available",
        binding: {
          providerId: "jj",
          repositoryId,
          workingCopyId: root,
          root,
          cwd: path.resolve(cwd),
        },
      };
    } catch (error) {
      return {
        status: "unavailable",
        error:
          error instanceof VcsError ? error.problem : { code: "provider", message: String(error) },
      };
    }
  },
  async observation(binding, context) {
    const gitDirectory = (await run(binding.root, ["git", "root"], context, true)).trim();
    const trackedFiles = jsonLines(
      await run(
        binding.root,
        ["--at-op", "@", "file", "list", "-T", 'json(path) ++ "\\n"'],
        context,
        true,
      ),
      z.string(),
    );
    const heads = path.join(binding.repositoryId, "op_heads");
    const workingCopy = path.join(binding.root, ".jj", "working_copy");
    const gitMetadata = ["HEAD", "index", "config", "packed-refs", "refs", "info/exclude"].map(
      (name) => path.join(gitDirectory, name),
    );
    return {
      fingerprint: await fingerprintVcsPaths([
        heads,
        path.join(workingCopy, "checkout"),
        ...gitMetadata,
      ]),
      roots: [
        {
          path: binding.root,
          scope: "working-copy" as const,
          kind: "files" as const,
          ignore: [
            path.join(binding.root, ".jj"),
            path.join(binding.root, ".git"),
            ...(await gitObservationIgnoredDirectories({
              cwd: binding.root,
              gitDirectory,
              trackedFiles,
              signal: context.signal,
            })),
          ],
        },
        { path: heads, scope: "repository" as const },
        { path: workingCopy, scope: "working-copy" as const },
        {
          path: gitDirectory,
          scope: "repository" as const,
          ignore: ["objects", "logs", "worktrees", "hooks", "lfs", "rr-cache"].map((name) =>
            path.join(gitDirectory, name),
          ),
        },
      ],
    };
  },
  async snapshot(binding, context) {
    let state: "ready" | "stale" = "ready";
    try {
      await run(binding.root, ["status"], context);
    } catch (error) {
      if (error instanceof VcsError && error.problem.code === "stale") state = "stale";
      else throw error;
    }
    const version = (
      await run(binding.root, ["op", "log", "--no-graph", "-n", "1", "-T", "id"], context, true)
    ).trim();
    const current = (await history(binding, "@", 1, context, version))[0] ?? null;
    const output = await run(
      binding.root,
      [
        "--at-op",
        version,
        "diff",
        "-T",
        '"{\\"path\\":" ++ json(path) ++ ",\\"status\\":" ++ json(status) ++ ",\\"conflict\\":" ++ json(target.conflict()) ++ "}\\n"',
      ],
      context,
      true,
    );
    const refsOutput = await run(
      binding.root,
      ["--at-op", version, "bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'],
      context,
      true,
    );
    const refs = jsonLines(refsOutput, refSchema).map((ref) =>
      VcsRefSchema.parse({
        id: JSON.stringify([ref.name, ref.remote ?? null]),
        name: ref.name,
        kind: "bookmark",
        targets: ref.target ?? [],
        remote: ref.remote,
        tracked: ref.remote ? ref.tracking_target !== undefined : undefined,
        publishable: !ref.remote && ref.target?.length === 1,
      }),
    );
    const changedFiles = jsonLines(output, fileSchema);
    if (current) current.conflict ||= changedFiles.some((file) => file.conflict);
    return {
      binding,
      version,
      workingComparison: current ? { kind: "revision", revision: current.id } : undefined,
      current,
      files: changedFiles,
      refs,
      state,
      capabilities: ["history", "diff", "refs", "actions"],
      actions: actionIds.map((id) => ({
        id,
        preview: rewritingActions.has(id),
        enabled: state === "stale" ? id === "update-stale" : id !== "update-stale",
      })),
    };
  },
  async history(binding, input, context) {
    const cursorSchema = z.object({
      operation: z.string().regex(/^[a-f0-9]+$/),
      offset: z.number().int().nonnegative().max(100_000),
    });
    const cursor = input.cursor
      ? cursorSchema.parse(JSON.parse(input.cursor))
      : {
          operation:
            input.version ??
            (
              await run(
                binding.root,
                ["op", "log", "--no-graph", "-n", "1", "-T", "id"],
                context,
                true,
              )
            ).trim(),
          offset: 0,
        };
    const revisions = await history(
      binding,
      "all()",
      cursor.offset + input.limit + 1,
      context,
      cursor.operation,
    );
    const next =
      revisions.length > cursor.offset + input.limit
        ? JSON.stringify({ operation: cursor.operation, offset: cursor.offset + input.limit })
        : undefined;
    return { revisions: revisions.slice(cursor.offset, cursor.offset + input.limit), cursor: next };
  },
  async diff(binding, comparison, context) {
    let args: string[] = [];
    if (comparison.kind === "working-copy" && comparison.data) {
      const input = jjComparisonData.parse(comparison.data).data;
      args = input.base ? ["--from", input.base, "--to", input.revision] : ["-r", input.revision];
      args.push("--at-operation", input.operation);
      if (input.ignoreWhitespace) args.push("--ignore-all-space");
    }
    if (comparison.kind === "revision") args = ["-r", revision.parse(comparison.revision)];
    if (comparison.kind === "range")
      args = ["--from", revision.parse(comparison.from), "--to", revision.parse(comparison.to)];
    return run(binding.root, ["diff", "--git", ...args], context, true);
  },
  async previewAction(binding, action, input, context) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Action parameters must be an object");
    const value = actionInput.parse({ ...input, action });
    await validateFileSelection(binding, value, context);
    if (!rewritingActions.has(value.action))
      throw new VcsError({ code: "unavailable", message: "This action has no rewrite preview" });
    if (value.action === "bookmark-delete" || value.action === "bookmark-set") {
      const ref = context.snapshot.refs.find((item) => item.name === value.name && !item.remote);
      if (value.action === "bookmark-delete" && !ref)
        throw new VcsError({ code: "outdated", message: "Bookmark no longer exists" });
      const revisions =
        value.action === "bookmark-set"
          ? await history(binding, value.revision, 1, context, context.snapshot.version)
          : [];
      return { revisions, files: [], refs: ref ? [ref] : [] };
    }
    let targets: string[];
    if (value.action === "restore") {
      if (!context.snapshot.current) throw new Error("Missing working-copy revision");
      targets = [context.snapshot.current.id];
    } else if (value.action === "squash") targets = [value.revision, value.destination];
    else if ("revision" in value) targets = [value.revision];
    else throw new Error("Missing rewrite target");
    // Read the operation captured by the executor; never snapshot once per affected change.
    const revisions = await history(
      binding,
      `descendants(${targets.join(" | ")})`,
      1001,
      context,
      context.snapshot.version,
    );
    if (revisions.length > 1000)
      throw new VcsError({
        code: "unavailable",
        message: "Rewrite affects more than 1000 revisions; narrow the operation before confirming",
      });
    for (const target of targets)
      if (!revisions.some((item) => item.id === target))
        throw new VcsError({ code: "outdated", message: "Rewrite target is no longer visible" });
    const affected = new Set(revisions.map((item) => item.id));
    return {
      revisions,
      files: "files" in value ? value.files : [],
      refs: context.snapshot.refs.filter(
        (ref) => !ref.remote && ref.targets.some((id) => affected.has(id)),
      ),
    };
  },
  async execute(binding, action, input, context) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("Action parameters must be an object");
    const value = actionInput.parse({ ...input, action });
    await validateFileSelection(binding, value, context);
    let args: string[];
    switch (value.action) {
      case "new":
        args = ["new", ...value.parents];
        break;
      case "edit":
        args = ["edit", value.revision];
        break;
      case "describe":
        args = ["describe", "-r", value.revision, "-m", value.message];
        break;
      case "abandon":
        args = ["abandon", value.revision];
        break;
      case "rebase":
        args = ["rebase", "-r", value.revision, "-d", value.destination];
        break;
      case "squash":
        args = [
          "squash",
          "--from",
          value.revision,
          "--into",
          value.destination,
          "--use-destination-message",
          "--",
          ...value.files.map((file) => `root-file:${JSON.stringify(file)}`),
        ];
        break;
      case "split":
        args = [
          "split",
          "-r",
          value.revision,
          "-m",
          value.message,
          "--",
          ...value.files.map((file) => `root-file:${JSON.stringify(file)}`),
        ];
        break;
      case "restore":
        args = [
          "restore",
          "--from",
          value.revision,
          "--",
          ...value.files.map((file) => `root-file:${JSON.stringify(file)}`),
        ];
        break;
      case "bookmark-create":
        args = ["bookmark", "create", JSON.stringify(value.name), "-r", value.revision];
        break;
      case "bookmark-set":
        args = [
          "bookmark",
          "set",
          "--allow-backwards",
          JSON.stringify(value.name),
          "-r",
          value.revision,
        ];
        break;
      case "bookmark-delete":
        args = ["bookmark", "delete", `exact:${JSON.stringify(value.name)}`];
        break;
      case "bookmark-track":
        if (
          !context.snapshot.refs.some(
            (ref) => ref.name === value.name && ref.remote === value.remote,
          )
        )
          throw new VcsError({
            code: "outdated",
            message: "Remote bookmark no longer exists; refresh before tracking it",
          });
        // jj parses these as expressions; quoting keeps @ and other syntax literal.
        args = [
          "bookmark",
          "track",
          "--remote",
          `exact:${JSON.stringify(value.remote)}`,
          "--",
          `exact:${JSON.stringify(value.name)}`,
        ];
        break;
      case "fetch":
        args = ["git", "fetch", "--remote", `exact:${JSON.stringify(value.remote)}`];
        break;
      case "push":
        args = [
          "git",
          "push",
          "--remote",
          `exact:${JSON.stringify(value.remote)}`,
          "--bookmark",
          `exact:${JSON.stringify(value.name)}`,
        ];
        break;
      case "update-stale":
        args = ["workspace", "update-stale"];
        break;
    }
    return { output: await run(binding.root, args, context) };
  },
};
