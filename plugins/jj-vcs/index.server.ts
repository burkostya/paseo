import type { PluginServerContext } from "@getpaseo/plugin/server";
import { jjProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerVcsProvider(jjProvider);
  return () => {};
}
