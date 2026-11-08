import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import type { VcsRevision } from "@getpaseo/plugin";

export const metadata = ".paseo-checkpoints";
export const filename = "note.txt";
export const maxCheckpoints = 32;
export const textSchema = z
  .string()
  .max(16384)
  .refine((value) => !value.includes("\0"), "Text files only")
  .nullable();
const checkpointSchema = z.object({
  id: z.string().min(1),
  parents: z.array(z.string()).max(1),
  description: z.string().trim().min(1).max(200),
  timestamp: z.string().datetime(),
  text: textSchema,
});
export const historySchema = z.object({
  version: z.literal(1),
  checkpoints: z.array(checkpointSchema).max(maxCheckpoints),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CapturedState = Awaited<ReturnType<typeof readState>>;

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readOptional(file: string, signal: AbortSignal) {
  try {
    return await readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
export async function readHistory(root: string, signal: AbortSignal) {
  const raw = await readOptional(path.join(root, metadata, "history.json"), signal);
  return historySchema.parse(raw === null ? { version: 1, checkpoints: [] } : JSON.parse(raw));
}
export async function readState(root: string, signal: AbortSignal) {
  const history = await readHistory(root, signal);
  const text = textSchema.parse(await readOptional(path.join(root, filename), signal));
  return { root, history, text, version: digest([history, text]) };
}
export function revision(checkpoint: Checkpoint): VcsRevision {
  return {
    id: checkpoint.id,
    parents: checkpoint.parents,
    description: checkpoint.description,
    timestamp: checkpoint.timestamp,
    author: { name: "Checkpoint example", email: "" },
    conflict: false,
  };
}
export function findCheckpoint(history: CapturedState["history"], id: string) {
  const checkpoint = history.checkpoints.find((entry) => entry.id === id);
  if (!checkpoint)
    throw new VcsError({ code: "outdated", message: "Checkpoint is unavailable; refresh Changes" });
  return checkpoint;
}
export async function saveCheckpoint(
  state: CapturedState,
  description: string,
  signal: AbortSignal,
) {
  const parent = state.history.checkpoints[0];
  const content = {
    parents: parent ? [parent.id] : [],
    description,
    timestamp: new Date().toISOString(),
    text: state.text,
  };
  const checkpoint = { ...content, id: `checkpoint:${digest(content)}` };
  const history = historySchema.parse({
    version: 1,
    checkpoints: [checkpoint, ...state.history.checkpoints],
  });
  const target = path.join(state.root, metadata, "history.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(history), { encoding: "utf8", flag: "wx", signal });
    if (signal.aborted) throw new VcsError({ code: "cancelled", message: "Checkpoint cancelled" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return checkpoint.id;
}
