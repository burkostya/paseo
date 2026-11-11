import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { draft, guideDocument } from "../shared/review";
import { cliVersion, decision, reviewUrl } from "./contract";
import type { ReviewEngine, EngineSession, EngineGuide, EngineState } from "./ports";
const exec = promisify(execFile);
const savedGuides = z.array(z.object({ id: z.string() }));
const savedGuide = guideDocument.extend({ reviewed: z.array(z.boolean()) });
const ok = z.object({ ok: z.literal(true) });

// These are the UI HTTP contracts of 0.28.53 (including the fleet stdin patch), not an upstream SDK.
export function createEngine(environment: NodeJS.ProcessEnv): ReviewEngine {
  return {
    async open({ cwd, revision, directory }) {
      if (!revision.patchPath) throw new Error("Legacy review has no saved patch; update it first");
      const dataDirectory = join(directory, "plannotator");
      const env: NodeJS.ProcessEnv = {
        ...environment,
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_BROWSER: "none",
        PLANNOTATOR_DATA_DIR: dataDirectory,
      };
      delete env.PLANNOTATOR_PORT;
      const version = (
        await exec("plannotator", ["--version"], { env, timeout: 5000 })
      ).stdout.trim();
      if (!cliVersion.safeParse(version).success)
        throw new Error(
          `Unsupported Plannotator version: ${version}. Install 0.28.53 or 0.28.53-paseo.1.`,
        );
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const child = spawn(
        "plannotator",
        ["review", "--json", "--patch-file", revision.patchPath, "--no-git-remote-check"],
        {
          cwd,
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      function signalOwned(signal: NodeJS.Signals) {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      let stopped = false;
      let output = "";
      let diagnostics = "";
      let failure: Error | null = null;
      let settled = false;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.on("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 8 * 1024 * 1024) {
          failure = new Error("Plannotator output exceeds 8 MiB");
          signalOwned("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-16000);
      });
      const result = closed.then(() => {
        settled = true;
        // The isolated process group also owns any native Guide provider children.
        signalOwned("SIGKILL");
        if (stopped) return null;
        if (failure) throw failure;
        if (child.exitCode !== 0)
          throw new Error(
            `Plannotator exited ${child.signalCode ?? child.exitCode}${diagnostics ? `\n${diagnostics}` : ""}`,
          );
        return decision.parse(JSON.parse(output));
      });
      // The coordinator attaches after URL discovery; retain early failures meanwhile.
      void result.catch(() => {});
      async function stop() {
        stopped = true;
        if (settled) return;
        const timer = setTimeout(() => signalOwned("SIGKILL"), 2000);
        signalOwned("SIGTERM");
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
      let url: string | null = null;
      try {
        for (let attempt = 0; attempt < 60; attempt++) {
          if (failure) throw failure;
          if (settled) throw new Error(diagnostics || "Plannotator stopped before opening review");
          const sessions = await exec("plannotator", ["sessions", "--json"], {
            env,
            timeout: 3000,
            maxBuffer: 1024 * 1024,
          });
          url = reviewUrl(sessions.stdout, child.pid ?? -1);
          if (url) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!url) throw new Error("Timed out waiting for Plannotator URL");
        const liveUrl = url;
        async function api(path: string, method = "GET", body?: unknown): Promise<unknown | null> {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await fetch(new URL(path, liveUrl), {
              method,
              headers: { "Content-Type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: controller.signal,
            });
            if (response.status === 404 && path === "/api/draft" && method === "GET") return null;
            if (!response.ok) throw new Error(`Plannotator ${path}: HTTP ${response.status}`);
            return await response.json();
          } finally {
            clearTimeout(timer);
          }
        }
        const advertised = z
          .object({ rawPatch: z.string(), sourceKind: z.literal("patch") })
          .parse(await api("/api/diff"));
        if (advertised.rawPatch !== (await readFile(revision.patchPath, "utf8")))
          throw new Error("Plannotator opened another patch");
        if (revision.draft) {
          // Offer the saved snapshot through the native Restore draft action.
          // A fresh generation allows restoration after a settled native draft.
          const existing = await api("/api/draft");
          if (existing === null)
            ok.parse(
              await api("/api/draft", "POST", {
                ...revision.draft,
                draftGeneration: Date.now(),
                ts: Date.now(),
              }),
            );
        }
        const session: EngineSession = {
          url: liveUrl,
          result,
          stop,
          async read(): Promise<EngineState> {
            const rawDraft = await api("/api/draft");
            const guides: EngineGuide[] = [];
            for (const item of savedGuides.parse(await api("/api/guides"))) {
              const document = savedGuide.parse(
                await api(`/api/guide/${encodeURIComponent(`saved:${item.id}`)}`),
              );
              guides.push({
                id: item.id,
                document: guideDocument.parse(document),
                reviewed: document.reviewed,
              });
            }
            return { draft: rawDraft === null ? null : draft.parse(rawDraft), guides };
          },
          async importGuide(document) {
            const path = join(directory, "import-guide.json");
            await writeFile(path, JSON.stringify(guideDocument.parse(document)), { mode: 0o600 });
            const receipt = await exec(
              "plannotator",
              ["guide", "import", "--guide", path, "--patch", revision.patchPath!],
              {
                cwd,
                // Static-patch review has no Git context: its shelf is keyed by cwd,
                // not origin. Disable Git discovery only for this import by pointing
                // GIT_DIR at the saved patch (a file, never a Git directory).
                env: { ...env, GIT_DIR: revision.patchPath! },
                timeout: 10000,
              },
            );
            // 0.28.53 prints the saved id alone on stdout. A list difference can
            // misidentify a native Guide saved concurrently with this import.
            const id = z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
              .parse(receipt.stdout.trim());
            const after = savedGuides.parse(await api("/api/guides"));
            if (!after.some((item) => item.id === id))
              throw new Error(`Imported Guide ${id} is not visible in this static-patch review`);
            const imported = savedGuide.parse(
              await api(`/api/guide/${encodeURIComponent(`saved:${id}`)}`),
            );
            if (
              JSON.stringify(guideDocument.parse(imported)) !==
              JSON.stringify(guideDocument.parse(document))
            )
              throw new Error(`Imported Guide ${id} does not match the requested document`);
            return id;
          },
        };
        return session;
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}
