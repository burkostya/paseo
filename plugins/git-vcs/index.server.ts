import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGitProvider } from "./server/provider.js";
import { resolveGitSource } from "./server/working-copies.js";
import { resolveSourceRpc } from "./shared/working-copy.js";
export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const provider = createGitProvider(server.vcs);
  server.registerVcsProvider(provider);
  // COMPAT(gitSourceRpc): added in v0.15.2; remove after 2027-06-06 when cached pre-source-API contributions expire.
  server.handle(resolveSourceRpc, async ({ binding, selection }) => {
    const context = { signal: lifetime.signal };
    const actual = await provider.detect(binding.cwd, context);
    if (
      actual.status !== "available" ||
      Object.entries(binding).some(
        ([key, value]) => actual.binding[key as keyof typeof binding] !== value,
      )
    )
      throw new Error("Repository identity changed; reopen source selection");
    return resolveGitSource(binding, selection, context, server.vcs.resolveChangeRequest);
  });
  return () => lifetime.abort();
}
