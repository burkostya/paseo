import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  loadPersistedConfig,
  PersistedConfigSchema,
  savePersistedConfig,
} from "./persisted-config.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-config-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe("PersistedConfigSchema daemon auth config", () => {
  test("accepts optional daemon password hash", () => {
    const hash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        auth: { password: hash },
      },
    });

    expect(parsed.daemon?.auth?.password).toBe(hash);
  });
});

describe("PersistedConfigSchema daemon append system prompt config", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema daemon browser tools config", () => {
  test("accepts optional browser tools opt-in", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        browserTools: { enabled: true },
      },
    });

    expect(parsed.daemon?.browserTools?.enabled).toBe(true);
  });
});

describe("PersistedConfigSchema daemon relay config", () => {
  test("accepts optional relay TLS setting", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        relay: {
          enabled: true,
          endpoint: "relay.example.com:443",
          publicEndpoint: "public.example.com:443",
          useTls: true,
        },
      },
    });

    expect(parsed.daemon?.relay?.useTls).toBe(true);
  });
});

describe("PersistedConfigSchema daemon trusted proxy config", () => {
  test("accepts optional trusted proxy ranges", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: ["loopback", "172.16.0.0/12"],
      },
    });

    expect(parsed.daemon?.trustedProxies).toEqual(["loopback", "172.16.0.0/12"]);
  });

  test("accepts explicit trust-all proxy config", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: true,
      },
    });

    expect(parsed.daemon?.trustedProxies).toBe(true);
  });
});

describe("PersistedConfigSchema daemon web UI feature config", () => {
  test("accepts optional web UI enable flag and dist dir", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        webUi: {
          enabled: true,
          distDir: "web-ui-dist",
        },
      },
    });

    expect(parsed.features?.webUi).toEqual({
      enabled: true,
      distDir: "web-ui-dist",
    });
  });
});

describe("PersistedConfigSchema worktrees config", () => {
  test("accepts optional worktree root", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        root: "/mnt/fast/paseo-worktrees",
      },
    });

    expect(parsed.worktrees?.root).toBe("/mnt/fast/paseo-worktrees");
  });

  test("accepts service port allocation", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        servicePorts: { range: "3000-4000" },
      },
    });

    expect(parsed.worktrees?.servicePorts).toEqual({ range: "3000-4000" });
  });
});

describe("PersistedConfigSchema provider credentials", () => {
  test("accepts separate OpenAI STT and TTS credentials", () => {
    const parsed = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: {
            apiKey: " stt-secret ",
            baseUrl: " https://stt.example.com/v1 ",
          },
          tts: {
            apiKey: " tts-secret ",
            baseUrl: " https://tts.example.com/v1 ",
          },
        },
      },
    });

    expect(parsed.providers?.openai?.stt?.apiKey).toBe("stt-secret");
    expect(parsed.providers?.openai?.stt?.baseUrl).toBe("https://stt.example.com/v1");
    expect(parsed.providers?.openai?.tts?.apiKey).toBe("tts-secret");
    expect(parsed.providers?.openai?.tts?.baseUrl).toBe("https://tts.example.com/v1");
  });
});

describe("PersistedConfigSchema daemon append system prompt", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema agent provider runtime settings", () => {
  test("legacy append entries are skipped during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "append",
              args: ["--chrome"],
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({});
  });

  test("accepts provider command replace argv", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          codex: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "my-codex-wrapper"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.codex?.command).toEqual([
      "docker",
      "run",
      "--rm",
      "my-codex-wrapper",
    ]);
  });

  test("rejects replace command without argv", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          opencode: {
            command: {
              mode: "replace",
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("accepts metadata generation provider fallbacks", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        metadataGeneration: {
          providers: [
            { provider: "claude", model: "haiku" },
            { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
          ],
        },
      },
    });

    expect(parsed.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("accepts a custom provider catalog refresh timeout", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: { catalogRefreshTimeoutMs: 180_000 },
    });

    expect(parsed.agents?.catalogRefreshTimeoutMs).toBe(180_000);
  });

  test("rejects provider catalog refresh timeouts that overflow Node timers", () => {
    expect(() =>
      PersistedConfigSchema.parse({ agents: { catalogRefreshTimeoutMs: 2_147_483_648 } }),
    ).toThrow();
  });
});

describe("provider overrides (new format)", () => {
  test("override built-in provider with command and env", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: ["/opt/custom/claude"],
            env: {
              ANTHROPIC_API_KEY: "sk-test",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["/opt/custom/claude"],
      env: {
        ANTHROPIC_API_KEY: "sk-test",
      },
    });
  });

  test("new provider extending claude with label", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai).toEqual({
      extends: "claude",
      label: "ZAI",
    });
  });

  test("new provider extending acp with command", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
            command: ["my-agent", "--acp"],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.["my-agent"]).toEqual({
      extends: "acp",
      label: "My Agent",
      command: ["my-agent", "--acp"],
    });
  });

  test("enabled: false accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            enabled: false,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.enabled).toBe(false);
  });

  test("models array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            models: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.models).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("additionalModels array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            additionalModels: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.additionalModels).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("order field accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            order: 1,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.order).toBe(1);
  });

  test("new provider without extends → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("new provider without label → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends: acp without command → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends unknown provider → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "unknown",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("invalid provider ID format → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          ZAI: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("old format with mode: replace auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "claude"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["docker", "run", "--rm", "claude"],
    });
  });

  test("old format with mode: default auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({});
  });

  test("old format env preserved during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      env: {
        FOO: "bar",
      },
    });
  });

  test("mixed old and new format entries both work", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["custom-claude"],
            },
          },
          zai: {
            extends: "claude",
            label: "ZAI",
            command: ["zai"],
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({
      claude: {
        command: ["custom-claude"],
      },
      zai: {
        extends: "claude",
        label: "ZAI",
        command: ["zai"],
      },
    });
  });
});

describe("PersistedConfigSchema logging config", () => {
  test("accepts destination-specific logging config", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        console: {
          level: "info",
          format: "pretty",
        },
        file: {
          level: "trace",
          path: "daemon.log",
          rotate: {
            maxSize: "10m",
            maxFiles: 2,
          },
        },
      },
    });

    expect(parsed.log?.console?.level).toBe("info");
    expect(parsed.log?.file?.level).toBe("trace");
    expect(parsed.log?.file?.rotate?.maxFiles).toBe(2);
  });

  test("accepts legacy logging config fields", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        level: "debug",
        format: "json",
      },
    });

    expect(parsed.log?.level).toBe("debug");
    expect(parsed.log?.format).toBe("json");
  });

  test("rejects unknown logging config fields", () => {
    const result = PersistedConfigSchema.safeParse({
      log: {
        console: {
          level: "info",
          color: "red",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("PersistedConfigSchema voice mode config", () => {
  test("accepts a dedicated turn detection provider", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          turnDetection: {
            provider: "local",
          },
        },
      },
    });

    expect(parsed.features?.voiceMode?.turnDetection?.provider).toBe("local");
  });

  test("accepts trimmed STT language fields", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: " fr ",
          },
        },
        voiceMode: {
          stt: {
            language: " de ",
          },
        },
      },
    });

    expect(parsed.features?.dictation?.stt?.language).toBe("fr");
    expect(parsed.features?.voiceMode?.stt?.language).toBe("de");
  });
});

describe("loadPersistedConfig", () => {
  test("materializes relay disabled for a new Paseo home", () => {
    const home = createTempHome();
    try {
      const config = loadPersistedConfig(home);
      expect(config.daemon?.relay?.enabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("accepts the documented config schema marker", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://paseo.sh/schemas/paseo.config.v1.json",
            version: 1,
            daemon: {
              listen: "127.0.0.1:6767",
              hostnames: ["localhost", ".localhost"],
              mcp: { enabled: true },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.daemon?.listen).toBe("127.0.0.1:6767");
      expect(config.daemon?.hostnames).toEqual(["localhost", ".localhost"]);
      expect(config.daemon?.mcp?.enabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads a config that still uses the removed providers.openai.voice block", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            version: 1,
            providers: {
              openai: {
                apiKey: "global-key",
                voice: { apiKey: "voice-key", baseUrl: "https://voice.example.com/v1" },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.providers?.openai?.apiKey).toBe("global-key");
      expect((config.providers?.openai as Record<string, unknown>)?.voice).toBeUndefined();
      expect(config.providers?.openai?.stt).toBeUndefined();
      expect(config.providers?.openai?.tts).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("merges config fragments and the local override in filename order", () => {
    const home = createTempHome();
    const fragments = path.join(home, "conf.d");
    const configPath = path.join(home, "config.json");
    const localPath = path.join(home, "config.local.json");
    try {
      mkdirSync(fragments);
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            version: 1,
            daemon: {
              mcp: { enabled: false, injectIntoAgents: false },
              agentProfiles: [{ id: "base", name: "Base", provider: "claude" }],
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        path.join(fragments, "20-second.json"),
        `${JSON.stringify(
          {
            daemon: {
              mcp: { injectIntoAgents: true },
              agentProfiles: [{ id: "second", name: "Second", provider: "codex" }],
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        path.join(fragments, "10-first.json"),
        `${JSON.stringify(
          {
            daemon: { mcp: { enabled: true } },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        localPath,
        `${JSON.stringify(
          {
            daemon: {
              mcp: { injectIntoAgents: null },
              agentProfiles: [{ id: "local", name: "Local", provider: "pi" }],
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(loadPersistedConfig(home)).toMatchObject({
        daemon: {
          mcp: { enabled: true },
          agentProfiles: [{ id: "local", name: "Local", provider: "pi" }],
        },
      });
      expect(loadPersistedConfig(home).daemon?.mcp?.injectIntoAgents).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("merges partial nested provider overrides across layers", () => {
    const home = createTempHome();
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({
          version: 1,
          agents: {
            providers: {
              review: { extends: "claude", label: "Review" },
            },
          },
        }),
      );
      writeFileSync(
        path.join(home, "conf.d", "20-provider.json"),
        JSON.stringify({ agents: { providers: { review: { enabled: false } } } }),
      );

      expect(loadPersistedConfig(home).agents?.providers?.review).toEqual({
        extends: "claude",
        label: "Review",
        enabled: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applies the legacy allowedHosts alias at its layer priority", () => {
    const home = createTempHome();
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { hostnames: ["base.example.test"] } }),
      );
      writeFileSync(
        path.join(home, "conf.d", "20-hosts.json"),
        JSON.stringify({ daemon: { allowedHosts: ["fragment.example.test"] } }),
      );

      expect(loadPersistedConfig(home).daemon?.hostnames).toEqual(["fragment.example.test"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("includes symlinked fragment files and does not create a missing base file", () => {
    const home = createTempHome();
    const fragments = path.join(home, "conf.d");
    const source = path.join(home, "agent-profiles.json");
    try {
      mkdirSync(fragments);
      writeFileSync(
        source,
        JSON.stringify({
          daemon: { agentProfiles: [{ id: "linked", name: "Linked", provider: "pi" }] },
        }),
      );
      symlinkSync(source, path.join(fragments, "20-agent-profiles.json"));

      expect(loadPersistedConfig(home).daemon?.agentProfiles).toEqual([
        { id: "linked", name: "Linked", provider: "pi" },
      ]);
      expect(existsSync(path.join(home, "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("saves only the local delta when layered config is enabled", () => {
    const home = createTempHome();
    const fragments = path.join(home, "conf.d");
    try {
      mkdirSync(fragments);
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" } }),
      );
      writeFileSync(
        path.join(fragments, "20-base.json"),
        JSON.stringify({ daemon: { browserTools: { enabled: false } } }),
      );

      const desired = loadPersistedConfig(home);
      desired.daemon = {
        ...desired.daemon,
        agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
      };
      const savedPath = savePersistedConfig(home, desired);

      expect(savedPath).toBe(path.join(home, "config.local.json"));
      expect(JSON.parse(readFileSync(savedPath, "utf-8"))).toEqual({
        daemon: {
          agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
        },
      });
      expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8"))).toEqual({
        version: 1,
        daemon: { listen: "127.0.0.1:6767" },
      });
      expect(loadPersistedConfig(home).daemon?.agentProfiles).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps local profiles when the Fleet base file changes", () => {
    const home = createTempHome();
    const fragments = path.join(home, "conf.d");
    try {
      mkdirSync(fragments);
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { browserTools: { enabled: false } } }),
      );
      const desired = loadPersistedConfig(home);
      desired.daemon = {
        ...desired.daemon,
        agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
      };
      savePersistedConfig(home, desired);

      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { browserTools: { enabled: true } } }),
      );

      expect(loadPersistedConfig(home).daemon?.browserTools?.enabled).toBe(true);
      expect(loadPersistedConfig(home).daemon?.agentProfiles).toEqual([
        { id: "local", name: "Local", provider: "codex" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preserves unrelated local overrides when saving another setting", () => {
    const home = createTempHome();
    const localPath = path.join(home, "config.local.json");
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { browserTools: { enabled: false } } }),
      );
      writeFileSync(localPath, JSON.stringify({ daemon: { browserTools: { enabled: true } } }));

      const desired = loadPersistedConfig(home);
      desired.daemon = {
        ...desired.daemon,
        agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
      };
      savePersistedConfig(home, desired);

      expect(JSON.parse(readFileSync(localPath, "utf-8"))).toEqual({
        daemon: {
          browserTools: { enabled: true },
          agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
        },
      });
      expect(loadPersistedConfig(home).daemon?.browserTools?.enabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses null tombstones when a local save removes an inherited key", () => {
    const home = createTempHome();
    const localPath = path.join(home, "config.local.json");
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { appendSystemPrompt: "Fleet prompt" } }),
      );

      const desired = loadPersistedConfig(home);
      desired.daemon = { ...desired.daemon };
      delete desired.daemon.appendSystemPrompt;
      savePersistedConfig(home, desired);

      expect(JSON.parse(readFileSync(localPath, "utf-8"))).toEqual({
        daemon: { appendSystemPrompt: null },
      });
      expect(loadPersistedConfig(home).daemon?.appendSystemPrompt).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolves a new nested override after a parent tombstone", () => {
    const home = createTempHome();
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { browserTools: { enabled: false } } }),
      );
      writeFileSync(path.join(home, "config.local.json"), JSON.stringify({ daemon: null }));

      const desired = loadPersistedConfig(home);
      desired.daemon = {
        agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
      };
      savePersistedConfig(home, desired);

      expect(loadPersistedConfig(home)).toEqual({
        version: 1,
        daemon: {
          agentProfiles: [{ id: "local", name: "Local", provider: "codex" }],
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("removes an empty local override and returns to lower layers", () => {
    const home = createTempHome();
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({
          version: 1,
          daemon: { agentProfiles: [{ id: "base", name: "Base", provider: "pi" }] },
        }),
      );
      const desired = loadPersistedConfig(home);
      desired.daemon = { ...desired.daemon, agentProfiles: [] };
      savePersistedConfig(home, desired);
      expect(loadPersistedConfig(home).daemon?.agentProfiles).toEqual([]);

      const inherited = loadPersistedConfig(home);
      inherited.daemon = {
        ...inherited.daemon,
        agentProfiles: [{ id: "base", name: "Base", provider: "pi" }],
      };
      savePersistedConfig(home, inherited);

      expect(existsSync(path.join(home, "config.local.json"))).toBe(false);
      expect(loadPersistedConfig(home).daemon?.agentProfiles).toEqual([
        { id: "base", name: "Base", provider: "pi" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports the fragment path for invalid JSON", () => {
    const home = createTempHome();
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(path.join(home, "conf.d", "20-broken.json"), "{ nope\n");

      expect(() => loadPersistedConfig(home)).toThrow(
        `Invalid JSON in ${path.join(home, "conf.d", "20-broken.json")}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports the contributing layers for an invalid merged config", () => {
    const home = createTempHome();
    const basePath = path.join(home, "config.json");
    const fragmentPath = path.join(home, "conf.d", "20-invalid.json");
    try {
      mkdirSync(path.join(home, "conf.d"));
      writeFileSync(basePath, JSON.stringify({ version: 1 }));
      writeFileSync(
        fragmentPath,
        JSON.stringify({ daemon: { browserTools: { enabled: "sometimes" } } }),
      );

      expect(() => loadPersistedConfig(home)).toThrow(
        `Invalid config after merging ${basePath}, ${fragmentPath}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("persisted config file permissions", () => {
  test("initializes config.json with private permissions", () => {
    const home = createTempHome();
    try {
      loadPersistedConfig(home);

      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs permissive config.json permissions when loading", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(configPath, "{}\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(configPath, PERMISSIVE_FILE_MODE);

      loadPersistedConfig(home);

      expect(modeOf(configPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("saves config.json with private permissions", () => {
    const home = createTempHome();
    try {
      savePersistedConfig(home, {
        providers: {
          openai: {
            apiKey: "secret",
          },
        },
      });

      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
