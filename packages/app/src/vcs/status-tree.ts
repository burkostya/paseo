import type { VcsSnapshot } from "@getpaseo/protocol/vcs";

type StatusFile = VcsSnapshot["files"][number];
interface DirectoryNode {
  kind: "directory";
  path: string;
  name: string;
  children: Map<string, StatusNode>;
}
interface FileNode {
  kind: "file";
  path: string;
  name: string;
  file: StatusFile;
}
type StatusNode = DirectoryNode | FileNode;
export type StatusTreeRow =
  | { kind: "directory"; path: string; name: string; depth: number; collapsed: boolean }
  | { kind: "file"; path: string; name: string; depth: number; file: StatusFile };

export function statusTreeRows(
  files: readonly StatusFile[],
  collapsedPaths: readonly string[],
): StatusTreeRow[] {
  const root: DirectoryNode = { kind: "directory", path: "", name: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    for (const name of parts.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      const key = `directory:${name}`;
      let node = parent.children.get(key);
      if (!node) {
        node = { kind: "directory", path, name, children: new Map() };
        parent.children.set(key, node);
      }
      if (node.kind === "directory") parent = node;
    }
    const name = parts.at(-1)!;
    parent.children.set(`file:${name}`, { kind: "file", path: file.path, name, file });
  }
  const collapsed = new Set(collapsedPaths);
  const rows: StatusTreeRow[] = [];
  function visit(directory: DirectoryNode, depth: number) {
    const children = [...directory.children.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name < b.name ? -1 : Number(a.name > b.name);
    });
    for (const child of children) {
      if (child.kind === "file")
        rows.push({ kind: "file", path: child.path, name: child.name, depth, file: child.file });
      else {
        rows.push({
          kind: "directory",
          path: child.path,
          name: child.name,
          depth,
          collapsed: collapsed.has(child.path),
        });
        if (!collapsed.has(child.path)) visit(child, depth + 1);
      }
    }
  }
  visit(root, 0);
  return rows;
}
