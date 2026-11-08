import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/** Hash durable metadata only. Providers exclude locks, logs and object stores. */
export async function fingerprintVcsPaths(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    hash.update(JSON.stringify(path));
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) hash.update(await readlink(path));
      else if (stat.isDirectory()) {
        for (const name of (await readdir(path)).sort()) {
          if (name === "lock" || name.endsWith(".lock")) continue;
          await visit(join(path, name));
        }
      } else if (stat.isFile()) hash.update(await readFile(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      hash.update("absent");
    }
  }
  for (const path of paths) await visit(path);
  return hash.digest("hex");
}
