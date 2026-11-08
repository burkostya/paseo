import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { metadata, missing } from "./store.js";

export const markerName = "copy.json";
export const markerSchema = z.object({
  version: z.literal(1),
  data: z.object({
    repositoryId: z.string(),
    token: z.string().uuid(),
    initialVersion: z.string(),
  }),
});

export async function readCopyMarker(root: string) {
  try {
    return markerSchema.parse(
      JSON.parse(await readFile(path.join(root, metadata, markerName), "utf8")),
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
