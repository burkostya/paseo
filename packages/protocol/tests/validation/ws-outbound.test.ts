import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { WSOutboundMessageSchema, ReviewAttachmentSchema } from "../../src/messages.js";
import { validateWSOutboundMessage } from "../../src/validation/ws-outbound.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWSOutboundPath = resolve(
  protocolRoot,
  "src/generated/validation/ws-outbound.aot.ts",
);
const require = createRequire(import.meta.url);

async function compileInlineSchema(sourceSchema: string): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "paseo-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
      await Promise.all([
        import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
      ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled = compileSchemas(schemas, { mode: "inline" });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("WS outbound zod-aot validation", () => {
  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileInlineSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(validateWSOutboundMessage({ type: "pong" }).success).toBe(true);
    expect(validateWSOutboundMessage({ type: "not_a_message" }).success).toBe(false);
  });

  it("validates opaque working-copy sources without assuming Git revisions or options", () => {
    const envelope = {
      type: "session",
      message: {
        type: "vcs.project.working-copy.resolve-source.response",
        payload: {
          requestId: "prepare",
          result: {
            revision: "change/version-7",
            data: { version: 3, data: { parents: ["one", "two"], mode: "isolated" } },
          },
          error: null,
        },
      },
    };
    const expected = WSOutboundMessageSchema.parse(envelope);
    expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: expected });
    envelope.message.payload.result.revision = "";
    expect(validateWSOutboundMessage(envelope).success).toBe(false);
    expect(WSOutboundMessageSchema.safeParse(envelope).success).toBe(false);
  });

  it("validates forge checkout facts and provider publication data through both validators", () => {
    const checkout = {
      type: "session",
      message: {
        type: "vcs.change-request.resolve-checkout.response",
        payload: {
          requestId: "checkout",
          error: null,
          result: {
            forge: "custom-forge",
            changeRequestNumber: 7,
            headRef: "feature",
            baseRefName: "main",
            checkoutRefs: [{ remoteRef: "refs/pull/7/head" }],
          },
        },
      },
    };
    const publication = {
      type: "session",
      message: {
        type: "vcs.publication.resolve.response",
        payload: {
          requestId: "publish",
          error: null,
          result: {
            remote: "fork",
            repositoryUrl: "https://example.test/repo",
            headRef: "feature",
            baseRef: "main",
            headRevision: "opaque",
            data: { version: 1, data: { localBranch: "alice/feature" } },
          },
        },
      },
    };
    for (const envelope of [checkout, publication]) {
      const expected = WSOutboundMessageSchema.safeParse(envelope);
      expect(expected.success).toBe(true);
      expect(validateWSOutboundMessage(envelope)).toMatchObject({
        success: true,
        data: expected.success ? expected.data : undefined,
      });
    }
    const invalid = structuredClone(checkout);
    invalid.message.payload.result.checkoutRefs = [];
    expect(WSOutboundMessageSchema.safeParse(invalid).success).toBe(false);
    expect(validateWSOutboundMessage(invalid).success).toBe(false);
  });

  it("accepts project config responses with and without setup commit status", () => {
    const payload = {
      requestId: "project-config-read",
      repoRoot: "/repo",
      ok: true,
      config: null,
      revision: null,
    };
    const envelope = (
      responsePayload: typeof payload & {
        hasUncommittedWorktreeSetupChanges?: boolean;
      },
    ) => ({
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: responsePayload,
      },
    });

    expect(validateWSOutboundMessage(envelope(payload)).success).toBe(true);
    expect(
      validateWSOutboundMessage(envelope({ ...payload, hasUncommittedWorktreeSetupChanges: true }))
        .success,
    ).toBe(true);
  });

  it("accepts a compact provider snapshot envelope", () => {
    const envelope = {
      type: "session",
      message: {
        type: "get_providers_snapshot_response",
        payload: {
          entries: [],
          compactSnapshot: {
            entries: [
              {
                provider: "pi",
                status: "ready",
                enabled: true,
                models: [{ id: "model-a", label: "Model A", thinkingSet: 0 }],
              },
            ],
            thinkingSets: [
              {
                options: [{ id: "high", label: "High", isDefault: true }],
                defaultOptionId: "high",
              },
            ],
          },
          snapshotHash: "snapshot-hash",
          generatedAt: "2026-08-04T00:00:00.000Z",
          requestId: "provider-snapshot",
        },
      },
    };

    expect(validateWSOutboundMessage(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(validateWSOutboundMessage(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("emits runtime imports with .js extensions", async () => {
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    expect(generated).toContain('from "./ws-outbound-schema-metadata.js"');
  });

  it("accepts a forge.search.response envelope", () => {
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("keeps each generated validator function small", async () => {
    // A single function for the whole protocol made V8's Maglev tier spend ~800 MB and seconds compiling it.
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    const starts = [...generated.matchAll(/function safeParse_\w+\(/g)].map((match) => match.index);
    const sizes = starts.map((start, index) => (starts[index + 1] ?? generated.length) - start);

    expect(Math.max(...sizes)).toBeLessThan(1_000_000);
    expect(sizes.length).toBeGreaterThan(1);
  });

  it("keeps nested union issue paths rooted at the envelope", () => {
    // Generated validators root branch issues at the input; runtime Zod reports them relative to the union.
    const envelope = {
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: { repoRoot: "/repo", ok: true, config: {}, revision: { mtimeMs: 1, size: 1 } },
      },
    };
    const paths = (issues: z.core.$ZodIssue[]): PropertyKey[][] =>
      issues.flatMap((issue) => [
        issue.path,
        ...(issue.code === "invalid_union" ? paths(issue.errors.flat()) : []),
      ]);

    const result = validateWSOutboundMessage(envelope);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(paths(result.error.issues)).toEqual([
      ["message", "payload"],
      ["message", "payload", "requestId"],
      ["message", "payload", "requestId"],
      ["message", "payload", "ok"],
      ["message", "payload", "error"],
    ]);
  });

  it("applies defaults from the matching session message schema", () => {
    const envelope = {
      type: "session",
      message: {
        type: "agent_update",
        payload: {
          kind: "upsert",
          agent: {
            id: "agent-1",
            provider: "claude",
            cwd: "/repo",
            model: "model",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastUserMessageAt: "2026-01-01T00:00:00.000Z",
            status: "initializing",
            capabilities: {
              supportsStreaming: false,
              supportsSessionPersistence: false,
              supportsDynamicModes: false,
              supportsMcpServers: false,
              supportsReasoningStream: false,
              supportsToolInvocations: false,
            },
            currentModeId: "default",
            availableModes: [],
            pendingPermissions: [],
            persistence: { provider: "claude", sessionId: "session-1" },
            title: "Agent",
          },
        },
      },
    };

    const result = validateWSOutboundMessage(envelope);
    const expected = WSOutboundMessageSchema.safeParse(envelope);

    expect(expected.success).toBe(true);
    expect(result).toEqual(expected);
    expect(result.success && result.data).toMatchObject({
      message: { payload: { agent: { capabilities: { supportsRewindConversation: false } } } },
    });
  });
});

it("validates VCS responses with generated validators and rejects malformed operation states", () => {
  const valid = {
    type: "session",
    message: {
      type: "vcs.operations.get.response",
      payload: {
        requestId: "vcs-request",
        result: { id: "operation", status: "unknown" },
        error: null,
      },
    },
  };
  expect(validateWSOutboundMessage(valid).success).toBe(true);
  const invalid = {
    ...valid,
    message: {
      ...valid.message,
      payload: { ...valid.message.payload, result: { id: "operation", status: "invented-status" } },
    },
  };
  expect(validateWSOutboundMessage(invalid).success).toBe(false);
  expect(
    validateWSOutboundMessage({
      ...valid,
      message: {
        ...valid.message,
        payload: {
          ...valid.message.payload,
          result: null,
          error: { code: "unsupported-version", message: "Update jj" },
        },
      },
    }).success,
  ).toBe(true);
});

it("validates VCS publication partial results and open forge facts", () => {
  const publication = {
    remote: "origin",
    repositoryUrl: "https://forge.test/repo",
    headRef: "task",
    headRevision: "opaque-revision",
    baseRef: "main",
  };
  const partial = {
    type: "session",
    message: {
      type: "vcs.change-request.execute.response",
      payload: {
        requestId: "create",
        result: {
          id: "create",
          status: "failed",
          result: { publication, stage: "published" },
          error: { code: "remote", message: "Forge unavailable" },
        },
        error: null,
      },
    },
  };
  expect(validateWSOutboundMessage(partial)).toEqual(WSOutboundMessageSchema.safeParse(partial));
  expect(validateWSOutboundMessage(partial).success).toBe(true);
  const status = {
    type: "session",
    message: {
      type: "vcs.change-request.get.response",
      payload: {
        requestId: "status",
        error: null,
        result: {
          forge: "external-forge",
          status: {
            url: "https://forge.test/repo/request/7",
            title: "Task",
            state: "open",
            baseRefName: "main",
            headRefName: "task",
            isMerged: false,
            mergeable: "UNKNOWN",
            checks: [{ name: "Build", status: "pending", url: null, traits: ["external-trait"] }],
            checksStatus: "pending",
            reviewDecision: null,
            forgeSpecific: { forge: "external-facts", custom: { supported: true } },
          },
        },
      },
    },
  };
  expect(validateWSOutboundMessage(status)).toEqual(WSOutboundMessageSchema.safeParse(status));
  expect(validateWSOutboundMessage(status).success).toBe(true);
});

it("accepts legacy and structured VCS diffs without imposing Git revision IDs", () => {
  const response = {
    type: "session",
    message: {
      type: "vcs.diff.get.response",
      payload: { requestId: "diff", result: { patch: "", files: [] }, error: null },
    },
  };
  expect(validateWSOutboundMessage(response).success).toBe(true);
  expect(
    validateWSOutboundMessage({
      ...response,
      message: {
        ...response.message,
        payload: { ...response.message.payload, result: { patch: "" } },
      },
    }).success,
  ).toBe(true);
  expect(
    validateWSOutboundMessage({
      ...response,
      message: {
        ...response.message,
        payload: { ...response.message.payload, result: { patch: "", files: [{ invalid: true }] } },
      },
    }).success,
  ).toBe(false);
});

it("validates VCS observation snapshots and errors for owned delivery", () => {
  const error = {
    type: "session",
    message: {
      type: "vcs.snapshot.changed",
      payload: {
        workspaceId: "workspace",
        subscriptionId: "owned",
        result: null,
        error: { code: "unavailable", message: "Plugin stopped" },
      },
    },
  };
  expect(validateWSOutboundMessage(error).success).toBe(true);
  expect(
    validateWSOutboundMessage({
      ...error,
      message: {
        ...error.message,
        payload: { ...error.message.payload, subscriptionId: undefined },
      },
    }).success,
  ).toBe(false);
  expect(
    validateWSOutboundMessage({
      type: "session",
      message: {
        type: "vcs.snapshot.get.response",
        payload: {
          requestId: "request",
          result: null,
          error: { code: "unavailable", message: "No provider" },
        },
      },
    }).success,
  ).toBe(true);
});

it("validates VCS provider comparison data without Git-specific enums", () => {
  const snapshot = {
    binding: {
      providerId: "external",
      repositoryId: "repo",
      workingCopyId: "copy",
      root: "/repo",
      cwd: "/repo",
    },
    version: "v1",
    current: null,
    files: [],
    refs: [],
    capabilities: [],
    actions: [],
    state: "ready",
    workingComparison: { kind: "working-copy", data: { version: 3, data: { token: "opaque" } } },
    comparisons: [
      {
        id: "custom",
        comparison: { kind: "working-copy", data: { version: 4, data: { mode: "custom" } } },
      },
    ],
    data: { version: 1, data: { branch: "main" } },
  };
  const message = {
    type: "session",
    message: {
      type: "vcs.snapshot.get.response",
      payload: { requestId: "request", result: snapshot, error: null },
    },
  };
  expect(validateWSOutboundMessage(message).success).toBe(true);
  expect(
    validateWSOutboundMessage({
      ...message,
      message: {
        ...message.message,
        payload: {
          ...message.message.payload,
          result: {
            ...snapshot,
            comparisons: [
              {
                id: "bad",
                comparison: { kind: "working-copy", data: { version: -1, data: null } },
              },
            ],
          },
        },
      },
    }).success,
  ).toBe(false);
});

it("accepts legacy reviews and retains provider-neutral comparison provenance", () => {
  const legacy = {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: "/repo",
    mode: "uncommitted",
    comments: [],
  };
  expect(ReviewAttachmentSchema.parse(legacy)).toEqual(legacy);
  const vcs = {
    providerId: "external",
    repositoryId: "repo",
    workingCopyId: "copy",
    version: "snapshot",
    comparison: { kind: "working-copy", data: { version: 2, data: { token: "provider-owned" } } },
  };
  expect(ReviewAttachmentSchema.parse({ ...legacy, vcs }).vcs).toEqual(vcs);
  expect(
    ReviewAttachmentSchema.safeParse({
      ...legacy,
      vcs: { ...vcs, comparison: { kind: "range", from: "a" } },
    }).success,
  ).toBe(false);
});
