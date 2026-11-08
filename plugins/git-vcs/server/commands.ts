import { execCommand } from "@getpaseo/plugin/server";
import type { VcsContext } from "@getpaseo/plugin/server/vcs";
export async function git(cwd: string, args: string[], context: VcsContext) {
  return (
    await execCommand("git", ["--no-pager", ...args], {
      cwd,
      signal: context.signal,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
      },
    })
  ).stdout;
}
