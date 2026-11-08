import { VcsError } from "@getpaseo/plugin/server/vcs";
import type { VcsProblem } from "@getpaseo/plugin";

/** Inspect stderr, not Error.message: the latter includes user-controlled command arguments. */
export function classifyJjError(
  error: unknown,
  args: readonly string[],
  signal: AbortSignal,
): VcsError {
  if (error instanceof VcsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
    return new VcsError({ code: "cancelled", message });
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT" &&
    "path" in error &&
    error.path === "jj"
  )
    return new VcsError({ code: "unavailable", message });
  const stderr =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  const diagnostic = stderr
    .split("\n")
    .filter((line) => /^Error: /i.test(line))
    .join("\n");
  if (/^Error: (?:The )?working copy is stale\b/im.test(diagnostic))
    return new VcsError({ code: "stale", message, recoveryAction: "update-stale" });
  let code: VcsProblem["code"] = "provider";
  if (
    /^Error: (?:Revision .+ (?:doesn't|does not) exist|Ambiguous (?:revision|change|commit)(?: ID)? prefix:)/im.test(
      diagnostic,
    )
  )
    code = "outdated";
  else if (
    /^Error: (?:Won't push commit \S+ since it |Bookmark already exists:|Refusing to move bookmark backwards or sideways:|Cannot .+ conflicted bookmark)/im.test(
      diagnostic,
    )
  )
    code = "conflict";
  else if (isRemoteFailure(error, args, stderr)) code = "remote";

  return new VcsError({ code, message });
}

function isRemoteFailure(error: unknown, args: readonly string[], stderr: string): boolean {
  // These are provider-owned argv arrays; publication pins --at-op before `git push`.
  const command = args[0] === "--at-op" ? args.slice(2) : args;
  const remote = command[0] === "git" && (command[1] === "fetch" || command[1] === "push");
  return (
    remote &&
    error instanceof Error &&
    "code" in error &&
    error.code === 1 &&
    !/^(?:Config error:|Internal error:|Error: (?:Failed to (?:snapshot|load)|Invalid config|Invalid configuration))/im.test(
      stderr,
    )
  );
}
