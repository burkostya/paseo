import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node init.mjs <new-demo-directory>");
const root = path.resolve(destination);
await mkdir(root);
await mkdir(path.join(root, ".paseo-checkpoints"));
await writeFile(path.join(root, "note.txt"), "My first checkpoint\n", { flag: "wx" });
console.log(`Open ${root} in Paseo.`);
