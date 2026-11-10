import { describe, expect, it } from "vitest";
import { decision, reviewUrl } from "./contract";
describe("Plannotator 0.28.53 contract", () => {
  it("selects the review belonging to the child PID", () => {
    const raw = JSON.stringify([
      { pid: 1, mode: "review", url: "http://localhost:1111" },
      { pid: 2, mode: "review", url: "http://localhost:32941" },
    ]);
    expect(reviewUrl(raw, 2)).toBe("http://localhost:32941/");
    expect(reviewUrl(raw, 3)).toBeNull();
  });
  it("rejects remote and non-http URLs", () => {
    for (const url of ["http://example.com:1234", "https://localhost:1234", "file:///tmp/review"]) {
      expect(() => reviewUrl(JSON.stringify([{ pid: 2, mode: "review", url }]), 2)).toThrow();
    }
  });
  it("preserves feedback and distinguishes dismissal", () => {
    expect(
      decision.parse({ decision: "annotated", message: "Paseo contract test\n" }).message,
    ).toBe("Paseo contract test\n");
    expect(decision.parse({ decision: "dismissed", message: "" }).decision).toBe("dismissed");
    expect(() => decision.parse({ feedback: "legacy" })).toThrow();
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createReviews } from "./reviews";

describe("review lifecycle", () => {
  let root: string;
  let reviews: ReturnType<typeof createReviews>;
  const send = vi.fn(async (_text: string, _options?: unknown) => {});
  const api = {
    agents: {
      ref: (_id: string) => ({
        cwd: root,
        workspaceId: "workspace",
        archivedAt: null,
        refresh: async () => null,
        send,
      }),
    },
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-review-test-"));
    await mkdir(join(root, "bin"));
    execFileSync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "bin", "plannotator"),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PASEO_HOME;
if (process.argv[2] === 'sessions') {
  const sessions = fs.readdirSync(root).filter(f => f.endsWith('.session')).map(f => JSON.parse(fs.readFileSync(path.join(root, f))));
  console.log(JSON.stringify(sessions));
} else {
  const file = path.join(root, process.pid + '.session');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, mode: 'review', url: 'http://localhost:' + (20000 + process.pid % 40000) }));
  process.on('exit', () => { try { fs.unlinkSync(file); } catch {} });
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {
    const result = path.join(root, process.pid + '.result');
    if (fs.existsSync(result)) { process.stdout.write(fs.readFileSync(result)); process.exit(0); }
  }, 20);
}
`,
      { mode: 0o700 },
    );

    send.mockClear();
    reviews = createReviews({
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      PASEO_HOME: root,
    });
  });
  afterEach(async () => {
    await reviews?.stop();
    await rm(root, { recursive: true, force: true });
  });
  async function complete(url: string | null, result: unknown) {
    for (const entry of await readdir(root)) {
      if (!entry.endsWith(".session")) continue;
      const session = JSON.parse(await readFile(join(root, entry), "utf8"));
      if (`${session.url}/` === url)
        await writeFile(join(root, entry.replace(".session", ".result")), JSON.stringify(result));
    }
  }
  it("coalesces launches and delivers only the selected agent's result", async () => {
    const [first, duplicate] = await Promise.all([
      reviews.start("a", "workspace", api),
      reviews.start("a", "workspace", api),
    ]);
    expect(first.id).toBe(duplicate.id);
    const second = await reviews.start("b", "workspace", api);
    expect(first.url).not.toBe(second.url);
    await complete(first.url, { decision: "annotated", message: "Check this line" });
    await vi.waitFor(async () =>
      expect((await reviews.get("a", "workspace"))?.status).toBe("sent"),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith("Check this line", { messageId: first.id });
    expect((await reviews.get("b", "workspace"))?.status).toBe("reviewing");
  });
  it("retains delivery failures across restarts and retries explicitly", async () => {
    send.mockRejectedValueOnce(new Error("connection lost"));
    const state = await reviews.start("a", "workspace", api);
    await complete(state.url, { decision: "annotated", message: "Saved feedback" });
    await vi.waitFor(async () =>
      expect((await reviews.get("a", "workspace"))?.status).toBe("delivery-failed"),
    );
    await reviews.stop();
    reviews = createReviews({
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      PASEO_HOME: root,
    });
    expect((await reviews.get("a", "workspace"))?.message).toBe("Saved feedback");
    await reviews.operate("a", "workspace", state.id, true, api);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await reviews.get("a", "workspace"))?.status).toBe("sent");
  });
  it("cancels without sending and rejects stale operation IDs", async () => {
    const state = await reviews.start("a", "workspace", api);
    await expect(reviews.operate("a", "workspace", "old", false, api)).rejects.toThrow(
      "no longer current",
    );
    await reviews.operate("a", "workspace", state.id, false, api);
    await reviews.stop();
    expect(send).not.toHaveBeenCalled();
    expect((await readdir(root)).filter((f) => f.endsWith(".session"))).toEqual([]);
  });
  it("dismisses without delivery and surfaces unsupported output", async () => {
    const first = await reviews.start("a", "workspace", api);
    await complete(first.url, { decision: "dismissed", message: "" });
    await vi.waitFor(async () =>
      expect((await reviews.get("a", "workspace"))?.status).toBe("cancelled"),
    );
    const second = await reviews.start("a", "workspace", api);
    await complete(second.url, { feedback: "unsupported" });
    await vi.waitFor(async () =>
      expect((await reviews.get("a", "workspace"))?.status).toBe("failed"),
    );
    expect(send).not.toHaveBeenCalled();
  });
});
