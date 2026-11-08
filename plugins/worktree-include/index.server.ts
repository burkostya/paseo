import type { PluginServerContext } from "@getpaseo/plugin/server";
import { copyWorktreeIncludes } from "./server/copy.js";

export default function contribute(server: PluginServerContext) {
  return server.addHook("working-copy.create.after", async ({ source, workingCopy }, context) => {
    await copyWorktreeIncludes({
      source,
      target: workingCopy.binding,
      vcs: server.vcs,
      signal: context.signal,
    });
  });
}
