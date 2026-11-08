import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
interface GitIgnoredFilesOptions {
  cwd: string;
  patterns: readonly string[];
  signal: AbortSignal;
  gitDirectory?: string;
  /** Overrides the Git index for a Git-backed VCS with a different tracking model. */
  trackedFiles?: readonly string[];
}

/** Gitignore matching without changing the repository or its real index. */
export async function listGitIgnoredFiles(options: GitIgnoredFilesOptions): Promise<string[]> {
  if (options.patterns.length === 0) return [];
  const temporary = await mkdtemp(join(tmpdir(), "paseo-vcs-files-"));
  try {
    const patternsFile = join(temporary, "patterns");
    await writeFile(patternsFile, options.patterns.join("\n") + "\n");
    const prefix = options.gitDirectory
      ? ["--git-dir", options.gitDirectory, "--work-tree", options.cwd, "-c", "core.bare=false"]
      : [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (options.trackedFiles) env.GIT_INDEX_FILE = join(temporary, "index");
    async function git(args: string[], input?: string): Promise<string> {
      const command = exec("git", [...prefix, ...args], {
        cwd: options.cwd,
        env,
        signal: options.signal,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (input !== undefined) command.child.stdin?.end(input);
      return (await command).stdout;
    }
    const candidates = (
      await git([
        "ls-files",
        "--others",
        "--ignored",
        "-z",
        `--exclude-from=${patternsFile}`,
        "--",
        ".",
        ":(exclude,glob)**/.jj/**",
        ":(exclude,glob)**/.git/**",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const tracked = new Set(options.trackedFiles);
    const selected = candidates.filter((file) => !tracked.has(file));
    if (selected.length === 0) return [];
    let ignored: string;
    try {
      ignored = await git(
        ["check-ignore", "--no-index", "--stdin", "-z"],
        selected.join("\0") + "\0",
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1) return [];
      throw error;
    }
    return ignored.split("\0").filter(Boolean);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Prune ignored trees without hiding tracked descendants, including a jj tracking model. */
export async function gitObservationIgnoredDirectories(
  options: Omit<GitIgnoredFilesOptions, "patterns">,
): Promise<string[]> {
  const prefix = options.gitDirectory
    ? ["--git-dir", options.gitDirectory, "--work-tree", options.cwd, "-c", "core.bare=false"]
    : [];
  async function git(args: string[]) {
    return (
      await exec("git", [...prefix, ...args], {
        cwd: options.cwd,
        signal: options.signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  }
  const candidates = (
    await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
  )
    .split("\0")
    .filter((file) => file.endsWith("/"));
  const tracked =
    options.trackedFiles ?? (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
  const trackedDirectories = new Set<string>();
  for (const file of tracked) {
    const parts = file.split("/");
    parts.pop();
    while (parts.length) {
      trackedDirectories.add(parts.join("/") + "/");
      parts.pop();
    }
  }
  return candidates
    .filter((directory) => !trackedDirectories.has(directory))
    .map((directory) => resolve(options.cwd, directory));
}
