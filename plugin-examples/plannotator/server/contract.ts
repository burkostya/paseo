import { z } from "zod";
export const decision = z.object({
  decision: z.enum(["approved", "annotated", "dismissed"]),
  message: z.string(),
});
export const sessions = z.array(
  z.object({ pid: z.number().int(), mode: z.string(), url: z.string().url() }),
);
export function reviewUrl(raw: string, pid: number): string | null {
  const session = sessions
    .parse(JSON.parse(raw))
    .find((entry) => entry.pid === pid && entry.mode === "review");
  if (!session) return null;
  const url = new URL(session.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Plannotator returned a non-loopback review URL");
  }
  return url.href;
}
