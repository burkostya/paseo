import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Files omitted from the VCS snapshot must keep the working copy on disk. */
interface Options {
  root: string;
  tracked: readonly string[];
  metadata: readonly string[];
  signal: AbortSignal;
}
export async function listUnpreservedFiles({
  root,
  tracked,
  metadata: allowedMetadata,
  signal,
}: Options): Promise<string[]> {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Working copy root is not a directory");
  const saved = new Set(tracked);
  const unsaved: string[] = [];
  async function visit(prefix: string): Promise<void> {
    signal.throwIfAborted();
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (unsaved.length >= 20) return;
      const metadata = entry.name === ".git" || entry.name === ".jj";
      if (!prefix && allowedMetadata.includes(entry.name)) continue;
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (metadata) unsaved.push(file);
      else if (entry.isDirectory()) await visit(file);
      else if (!saved.has(file)) unsaved.push(file);
    }
  }
  await visit("");
  return unsaved;
}
