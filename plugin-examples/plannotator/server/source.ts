import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { FileEntry, SourceSelection, Target } from "../shared/review";
import type { AgentConversation, ReviewSource } from "./ports";

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

// Git quotes unusual names using its C-string format, not JSON (octal UTF-8 escapes).
function pathName(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const source = raw.slice(1, -1);
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\\") {
      const character = String.fromCodePoint(source.codePointAt(i)!);
      bytes.push(...Buffer.from(character));
      i += character.length - 1;
      continue;
    }
    const octal = source.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += octal.length;
    } else {
      i++;
      bytes.push(escapes[source[i]] ?? source.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
function headerPaths(line: string): { oldPath: string; path: string } {
  const raw = line.slice("diff --git ".length);
  // Git leaves spaces unquoted. Prefer equal paths when a name itself contains " b/".
  for (const split of raw.matchAll(/ b\//g)) {
    const oldName = raw.slice(0, split.index);
    const newName = raw.slice(split.index + 1);
    if (oldName.startsWith("a/") && oldName.slice(2) === newName.slice(2))
      return { oldPath: oldName.slice(2), path: newName.slice(2) };
  }
  const header = line.match(/^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/);
  if (!header) throw new Error("Unsupported diff file header");
  return { oldPath: pathName(header[1]).slice(2), path: pathName(header[2]).slice(2) };
}
export function manifest(patch: string): FileEntry[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((part) => {
      const lines = part.split("\n");
      let { oldPath, path } = headerPaths(lines[0]);
      for (const line of lines) {
        if (line.startsWith("rename from ")) oldPath = pathName(line.slice(12));
        if (line.startsWith("rename to ")) path = pathName(line.slice(10));
      }
      let kind: FileEntry["kind"] = "modified";
      if (lines.some((line) => line.startsWith("new file mode "))) kind = "added";
      else if (lines.some((line) => line.startsWith("deleted file mode "))) kind = "deleted";
      else if (oldPath !== path) kind = "renamed";
      else if (
        lines.some((line) => line === "GIT binary patch" || line.startsWith("Binary files "))
      )
        kind = "binary";
      const identity = { path, oldPath: kind === "added" ? null : oldPath, kind };
      return {
        path: identity.path,
        oldPath: identity.oldPath,
        kind: identity.kind,
        fingerprint: hash(JSON.stringify(identity) + "\n" + part),
      };
    });
}
export function createSource(paseo: PaseoApi, conversation: AgentConversation): ReviewSource {
  async function context(target: Target) {
    const agent = await conversation.inspect(target);
    const workspace = paseo.workspaces.ref(target.workspaceId);
    await workspace.refresh();
    const snapshot = await workspace.vcs.snapshot();
    if (snapshot.binding.providerId !== "git")
      throw new Error("This review engine requires a Git workspace");
    return { agent, workspace, snapshot };
  }
  return {
    async prepare(target, selection) {
      const { agent, workspace, snapshot } = await context(target);
      const refs = snapshot.refs
        .filter((ref) => ref.targets.length === 1)
        .map((ref) => ({ value: ref.id, label: ref.name }));
      let resolved = null;
      let error = null;
      try {
        resolved = await workspace.vcs.comparison.resolve(snapshot.binding.providerId, selection);
      } catch (cause) {
        error = String(cause);
      }
      return {
        cwd: agent.cwd,
        agentName: agent.name,
        agentBusy: agent.busy,
        workspaceName: workspace.name ?? target.workspaceId,
        refs,
        resolved,
        error,
      };
    },
    async snapshot(target: Target, selection: SourceSelection) {
      const { workspace, snapshot } = await context(target);
      const resolved = await workspace.vcs.comparison.resolve(
        snapshot.binding.providerId,
        selection,
      );
      const { patch } = await workspace.vcs.diff(snapshot.binding.providerId, resolved.comparison);
      if (!patch.trim()) throw new Error("The selected comparison has no changes");
      const files = manifest(patch);
      if (!files.length) throw new Error("The patch contains no supported file entries");
      return { resolved, patch, files };
    },
  };
}
export function createConversation(paseo: PaseoApi): AgentConversation {
  async function ownedHelper(owner: import("./ports").GuideAgentOwner) {
    if (owner.agentId === owner.taskAgentId)
      throw new Error("The task agent cannot be a Guide helper");
    const agent = paseo.agents.ref(owner.agentId);
    if (!(await agent.refresh())) return null;
    if (
      agent.workspaceId !== owner.workspaceId ||
      agent.current()?.labels?.["plannotator.guide-request"] !== owner.requestId
    )
      throw new Error("Guide agent does not belong to this request and workspace");
    return agent;
  }
  return {
    async catalog(target) {
      const agent = await this.inspect(target);
      const [config, available] = await Promise.all([
        paseo.config.get(),
        paseo.providers.listAvailable(),
      ]);
      if (available.error) throw new Error(available.error);
      const profiles = (config.config.agentProfiles ?? []).map(({ id, name, provider, model }) => ({
        id,
        name,
        provider,
        model,
      }));
      const providers = await Promise.all(
        available.providers
          .filter((item) => item.available)
          .map(async ({ provider }) => {
            const result = await paseo.providers.listModels(provider, { cwd: agent.cwd });
            if (result.error) throw new Error(`${provider}: ${result.error}`);
            return {
              id: provider,
              models: (result.models ?? [])
                .filter((item) => item.isSelectable !== false)
                .map(({ id, label }) => ({ id, label })),
            };
          }),
      );
      return { profiles, providers };
    },
    async startHelper(target, helper, prompt, requestId) {
      if (typeof paseo.agents.ref(target.agentId).cancel !== "function")
        throw new Error("Update the Paseo host SDK before creating a separate Guide agent");
      const catalog = await this.catalog(target);
      if (
        !catalog.providers.some(
          (provider) =>
            provider.id === helper.provider &&
            provider.models.some((model) => model.id === helper.model),
        )
      )
        throw new Error("Selected provider or model is unavailable");
      if (
        helper.profileId &&
        !catalog.profiles.some(
          (profile) => profile.id === helper.profileId && profile.provider === helper.provider,
        )
      )
        throw new Error("Selected profile is unavailable for this provider");
      const profile = helper.profileId
        ? (await paseo.config.get()).config.agentProfiles?.find(
            (item) => item.id === helper.profileId,
          )
        : undefined;
      if (helper.profileId && (!profile || profile.provider !== helper.provider))
        throw new Error("Selected profile is no longer available");
      await paseo.workspaces.ref(target.workspaceId).agents.create({
        agentId: helper.agentId,
        idempotencyKey: requestId,
        title: "Plannotator Guide",
        prompt,
        config: {
          provider: `${helper.provider}/${helper.model}`,
          ...(helper.profileId ? { agentProfileId: helper.profileId } : {}),
          ...(profile?.modeId ? { modeId: profile.modeId } : {}),
          ...(profile?.model === helper.model && profile.thinkingOptionId
            ? { thinkingOptionId: profile.thinkingOptionId }
            : {}),
          ...(profile?.featureValues ? { featureValues: profile.featureValues } : {}),
        },
        labels: { "plannotator.guide-request": requestId },
      });
    },
    async helperState(owner) {
      const agent = await ownedHelper(owner);
      if (!agent) return "missing";
      if (agent.archivedAt) return "archived";
      return agent.status === "running" || agent.status === "initializing" || agent.activeTurn
        ? "running"
        : "finished";
    },
    async stopHelper(owner, cancel) {
      const agent = await ownedHelper(owner);
      if (!agent || agent.archivedAt) return;
      const running =
        agent.status === "running" || agent.status === "initializing" || agent.activeTurn;
      if (running) {
        if (!cancel) throw new Error("Guide agent is still running; waiting before archive");
        await agent.cancel();
      }
      await agent.archive();
    },
    async inspect(target) {
      const agent = paseo.agents.ref(target.agentId);
      await agent.refresh();
      if (!agent.cwd || agent.workspaceId !== target.workspaceId || agent.archivedAt)
        throw new Error("Original agent is unavailable in this workspace");
      return {
        cwd: agent.cwd,
        name: agent.current()?.title ?? target.agentId,
        busy: agent.activeTurn !== null || agent.status === "running",
      };
    },
    async send(target, text, messageId) {
      await this.inspect(target);
      // Steering is Paseo's non-interrupting send policy. Omitting this option interrupts.
      await paseo.agents.ref(target.agentId).send(text, { messageId, activeTurnBehavior: "steer" });
    },
  };
}
