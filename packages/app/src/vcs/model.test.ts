import { statusTreeRows } from "./status-tree";
import { openProjectSource } from "../../../../plugins/git-vcs/client/project-source-model";
import { resolveGitComparison } from "../../../../plugins/git-vcs/client/comparison";
import { resolveJjComparison } from "../../../../plugins/jj-vcs/client/comparison";
import { resolvePaneComparison } from "./comparison";
import { changesStateSchema, defaultChangesState } from "@/panels/changes/state";
import { selectedDiffFiles, vcsReviewDraftKey } from "./selection";
import { applyViewRequest, vcsViews, availableVcsView } from "./views";
import { defaultVcsPaneState } from "./state";
import { openGitActionForm } from "../../../../plugins/git-vcs/client/model";
import { describe, expect, it, vi } from "vitest";
import { openWorkingCopyForm } from "./working-copy-model";
import { openIsolationForm } from "@/screens/new-workspace/isolation-model";
import type { PluginVcsContext } from "@getpaseo/plugin/client";
import { openJjActionForm } from "../../../../plugins/jj-vcs/client/model";
import { openPublicationForm } from "./publication-model";
import {
  publicationIdentity,
  publicationStatusView,
  restorePublicationFields,
} from "./publication-state";
import type { VcsPublication } from "@getpaseo/protocol/vcs";
import { revisionGraph } from "./graph";
import { vcsPaneStateSchema } from "./state";
import {
  selectionComparison,
  applyComparisonRequest,
  selectWorkspaceComparison,
  selectComparisonBase,
} from "./selection";
import { z } from "zod";
const revision = (id: string, parents: string[] = []) => ({
  id,
  changeId: `change-${id}`,
  parents,
  description: "Initial description",
  author: { name: "Test", email: "test@example.test" },
  timestamp: "2026-11-06T00:00:00Z",
  conflict: false,
});
function context(): PluginVcsContext {
  const current = revision("1".repeat(40), ["2".repeat(40)]);
  return {
    workspaceId: "workspace",
    snapshot: {
      binding: {
        providerId: "external",
        repositoryId: "repo",
        workingCopyId: "copy",
        root: "/repo",
        cwd: "/repo/sub",
      },
      version: "version",
      current,
      files: [],
      refs: [],
      capabilities: [],
      actions: [],
      state: "ready",
      workingComparison: { kind: "revision", revision: current.id },
    },
    selection: { kind: "workspace" },
    revisions: [current, revision("2".repeat(40))],
    files: ["sub/a.txt", "sub/b.txt"],
  };
}
describe("VCS forms", () => {
  it("pins New workspace revisions across refresh and errors, and scopes them to the project binding", () => {
    const snapshot = context().snapshot;
    snapshot.capabilities = ["working-copies"];
    snapshot.actions = [{ id: "working-copy.create", enabled: true }];
    const model = openIsolationForm();
    expect(() => model.source("host/project", "project")).toThrow("Wait");
    model.apply("host/project", { status: "loaded", snapshot });
    model.select(revision("selected"));
    model.setProviderData({ version: 1, data: { name: "copy" } });
    model.apply("host/project", { status: "error", message: "Plugin unavailable" });
    expect(() => model.source("host/project", "project")).toThrow("Plugin unavailable");
    model.apply("host/project", {
      status: "loaded",
      snapshot: { ...snapshot, current: revision("new-current") },
    });
    expect(model.source("host/project", "project")).toEqual({
      kind: "working-copy",
      projectId: "project",
      providerId: "external",
      cwd: "/repo/sub",
      revision: "selected",
      providerData: { version: 1, data: { name: "copy" } },
    });
    expect(() => model.source("other-host/project", "project")).toThrow("Wait");
    model.apply("other-host/project", { status: "loaded", snapshot });
    expect(model.getState().revision).toEqual(snapshot.current);
    expect(model.getState().providerData).toBeUndefined();
    model.select(revision("another-selection"));
    model.apply("other-host/project", {
      status: "loaded",
      snapshot: { ...snapshot, binding: { ...snapshot.binding, providerId: "changed" } },
    });
    expect(model.source("other-host/project", "project")).toMatchObject({
      revision: snapshot.current!.id,
    });
  });
  it("blocks unavailable New workspace isolation without converting it to local creation", () => {
    const model = openIsolationForm();
    const snapshot = context().snapshot;
    model.apply("project", { status: "loaded", snapshot: null });
    expect(() => model.source("project", "project")).toThrow("unavailable");
    snapshot.capabilities = ["working-copies"];
    snapshot.actions = [
      { id: "working-copy.create", enabled: false, reason: "Repair stale workspace" },
    ];
    model.apply("project", { status: "loaded", snapshot });
    expect(() => model.source("project", "project")).toThrow("Repair stale workspace");
    const listener = vi.fn();
    model.subscribe(listener);
    model.close();
    model.select(revision("late"));
    expect(listener).not.toHaveBeenCalled();
  });
  it("pins working-copy intent and resumes an uncertain creation with the same key", async () => {
    const snapshot = context().snapshot;
    const input = { projectId: "project", binding: snapshot.binding, revision: snapshot.current };
    const model = openWorkingCopyForm(input);
    model.setTitle("Isolated task");
    const providerData = { version: 1, data: { nested: { name: "custom-name" } } };
    model.setProviderData(providerData);
    providerData.data.nested.name = "mutated outside the form";
    const create = vi.fn().mockRejectedValue(new Error("Disconnected"));
    const id = vi.fn(() => "creation-key");
    await model.submit({ id, create });
    expect(model.getState().status).toBe("unknown");
    model.setTitle("Must not change a pending intent");
    model.setProviderData({ version: 1, data: { name: "changed" } });
    model.reset();
    const saved = vcsPaneStateSchema.parse({
      ...defaultVcsPaneState,
      workingCopy: model.getState(),
    }).workingCopy;
    const restored = openWorkingCopyForm({ ...input, saved });
    const retry = vi.fn().mockResolvedValue({ workspaceId: "created", error: null });
    await restored.submit({ id, create: retry });
    expect(retry.mock.calls[0]).toEqual(create.mock.calls[0]);
    expect(retry.mock.calls[0][0]).toEqual({
      idempotencyKey: "creation-key",
      title: "Isolated task",
      source: {
        kind: "working-copy",
        projectId: "project",
        providerId: "external",
        cwd: "/repo/sub",
        revision: snapshot.current!.id,
        providerData: { version: 1, data: { nested: { name: "custom-name" } } },
      },
    });
    expect(id).toHaveBeenCalledOnce();
    expect(restored.getState()).toMatchObject({ status: "succeeded", workspaceId: "created" });
    expect(
      openWorkingCopyForm({
        ...input,
        binding: { ...input.binding, providerId: "other" },
        saved,
      }).getState().intent,
    ).toBeNull();
  });
  it("coalesces creation clicks and locks the revision until a definitive result", async () => {
    const snapshot = context().snapshot;
    const model = openWorkingCopyForm({
      projectId: "project",
      binding: snapshot.binding,
      revision: snapshot.current,
    });
    let finish!: (result: { workspaceId: string | null; error: string | null }) => void;
    const create = vi.fn(
      () =>
        new Promise<{ workspaceId: string | null; error: string | null }>((resolve) => {
          finish = resolve;
        }),
    );
    const deps = { id: () => "key", create };
    const pending = model.submit(deps);
    await model.submit(deps);
    model.selectRevision(revision("different"));
    expect(model.getState().revision).toBe(snapshot.current!.id);
    expect(create).toHaveBeenCalledOnce();
    finish({ workspaceId: null, error: "Creation failed" });
    await pending;
    expect(model.getState().status).toBe("failed");
    model.reset();
    model.selectRevision(revision("different"));
    expect(model.getState()).toMatchObject({ status: "idle", revision: "different", intent: null });
  });
  it("exposes panel shortcuts only where the plugin opts in", () => {
    const snapshot = context().snapshot;
    const panels = [
      { id: "hidden", title: "Hidden", Component: () => null },
      {
        id: "details",
        title: "Details",
        Component: () => null,
        entryPoints: ["workspace" as const],
      },
    ];
    const contribution = { providerId: "external", title: "External", actions: [], panels };
    const labels = {
      changes: "Changes",
      history: "History",
      refs: "Refs",
      publish: "Publish",
      workingCopy: "Create working copy",
    };
    const views = vcsViews(snapshot, contribution, String, labels);
    const withoutHistory = { ...snapshot, capabilities: ["diff"] };
    expect(
      vcsViews(withoutHistory, contribution, String, labels).map((view) => view.id),
    ).not.toContain("history");
    expect(
      vcsViews(
        { ...snapshot, capabilities: ["diff", "history"] },
        contribution,
        String,
        labels,
      ).map((view) => view.id),
    ).toContain("history");
    expect(availableVcsView(withoutHistory, "history")).toBe("changes");
    expect(availableVcsView(withoutHistory, "plugin:details")).toBe("plugin:details");

    expect(
      views.filter((view) => view.entryPoints?.includes("workspace")).map((view) => view.id),
    ).toEqual(["plugin:details"]);
    expect(views.filter((view) => view.entryPoints?.includes("command-center"))).toEqual([]);
    expect(
      vcsViews({ ...snapshot, capabilities: ["publication"] }, contribution, String, labels).find(
        (view) => view.id === "publish",
      )?.entryPoints,
    ).toEqual(["workspace", "command-center"]);
  });
  it("consumes VCS navigation once, including unavailable or different-provider panels", () => {
    const state = {
      ...defaultVcsPaneState,
      comparisonId: "base",
      baseRef: "main",
      operation: {
        providerId: "external",
        id: "pending",
        request: { kind: "action" as const, action: "describe", version: "snapshot", input: {} },
      },
    };
    const request = { providerId: "external", view: "plugin:details", requestId: "open" };
    const available = [{ id: "plugin:details" }];
    const opened = applyViewRequest(state, request, "external", available);
    expect(opened.unavailable).toBe(false);
    expect(opened.state.operation).toBe(state.operation);
    expect(opened.state).toMatchObject({
      view: "plugin:details",
      comparisonId: "base",
      baseRef: "main",
      consumedViewRequestId: "open",
    });
    const restored = vcsPaneStateSchema.parse({ ...opened.state, view: "history" });
    expect(applyViewRequest(restored, request, "external", available).state).toBe(restored);
    for (const [provider, views] of [
      ["external", []],
      ["another", available],
    ] as const) {
      const missing = applyViewRequest(state, request, provider, views);
      expect(missing.unavailable).toBe(true);
      expect(missing.state.view).toBe("changes");
      expect(applyViewRequest(missing.state, request, "external", available).state).toBe(
        missing.state,
      );
    }
  });
  it("preserves the selected exact revision and seeds each describe form separately", () => {
    const input = context();
    const model = openJjActionForm("describe", input);
    model.set("message", "Edited");
    expect(model.getState().input).toEqual({ revision: "1".repeat(40), message: "Edited" });
    expect(openJjActionForm("describe", input).getState().message).toBe("Initial description");
    expect(input.snapshot.version).toBe("version");
  });
  it("requires distinct squash targets and at least one whole file", () => {
    const model = openJjActionForm("squash", context());
    expect(model.getState().valid).toBe(false);
    model.set("destination", "1".repeat(40));
    expect(model.getState().valid).toBe(false);
    model.set("destination", "2".repeat(40));
    expect(model.getState().valid).toBe(true);
    model.toggleFile("sub/a.txt");
    model.toggleFile("sub/b.txt");
    model.toggleFile("outside.txt");
    expect(model.getState().valid).toBe(false);
    expect(model.getState().files).toEqual([]);
  });
  it("supports multiple explicit parents and rejects an empty parent selection", () => {
    const model = openJjActionForm("new", context());
    model.addParent("2".repeat(40));
    model.addParent("2".repeat(40));
    expect(model.getState().parents).toEqual(["1".repeat(40), "2".repeat(40)]);
    model.removeParent("1".repeat(40));
    model.removeParent("2".repeat(40));
    expect(model.getState().valid).toBe(false);
  });
  it("requires explicit choice when restoring from multiple parents", () => {
    const input = context();
    input.snapshot.current!.parents.push("3".repeat(40));
    const model = openJjActionForm("restore", input);
    expect(model.getState().valid).toBe(false);
    model.set("revision", "2".repeat(40));
    expect(model.getState().input).toEqual({
      revision: "2".repeat(40),
      files: ["sub/a.txt", "sub/b.txt"],
    });
    expect(model.getState().valid).toBe(true);
  });
  it("retains publication displays and validates user intent without reconstructing the form", () => {
    const model = openPublicationForm();
    model.set("remote", "origin", "Selected remote");
    model.set("headRef", "feature", "Task bookmark");
    model.set("baseRef", "main");
    model.set("title", "Task");
    expect(model.getState()).toMatchObject({
      canSubmit: true,
      remoteLabel: "Selected remote",
      headLabel: "Task bookmark",
    });
    model.set("title", " ");
    expect(model.getState().canSubmit).toBe(false);
  });
});
it("preserves operation identity and exact publication across panel restoration", () => {
  const input = {
    view: "publish",
    selection: { kind: "workspace" },
    operation: {
      providerId: "external",
      id: "stable-operation",
      request: {
        kind: "publication",
        target: {
          remote: "origin",
          repositoryUrl: "https://forge.test/repo",
          headRef: "feature",
          baseRef: "main",
          headRevision: "opaque-revision",
        },
        input: { action: "create", title: "Task", body: "", publish: false },
      },
    },
  };
  expect(vcsPaneStateSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
});
it("uses the provider's pinned working comparison and never chooses an ambiguous ref target", () => {
  const input = context();
  expect(selectionComparison({ kind: "workspace" }, input.snapshot)).toEqual(
    input.snapshot.workingComparison,
  );
  expect(
    selectionComparison(
      {
        kind: "ref",
        ref: { id: "ref", name: "conflicted", kind: "custom", targets: ["one", "two"] },
        revision: null,
      },
      input.snapshot,
    ),
  ).toBeNull();
});
it("draws every merge parent without imposing a single-parent history", () => {
  const rows = revisionGraph([
    revision("merge", ["left", "right"]),
    revision("left", ["base"]),
    revision("right", ["base"]),
    revision("base"),
  ]);
  expect(rows[0]!.edges).toEqual([
    { from: 0, to: 0, parent: "left" },
    { from: 0, to: 1, parent: "right" },
  ]);
  expect(rows[2]!.edges.some((edge) => edge.parent === "base")).toBe(true);
  expect(rows[3]!.edges).toEqual([]);
  expect(rows.map((row) => row.incoming)).toEqual([false, true, true, true]);
});

describe("Git plugin forms", () => {
  it("keeps partial staging and commit-all explicit", () => {
    const ctx = context();
    ctx.snapshot.files = [
      { path: "a", status: "MM", conflict: false },
      { path: "b", status: "??", conflict: false },
    ];
    const unstage = openGitActionForm("unstage", ctx);
    expect(unstage.candidates).toEqual(["a"]);
    const stage = openGitActionForm("stage", ctx);
    expect(stage.candidates).toEqual(["a", "b"]);
    stage.toggleFile("b");
    expect(stage.getState().input).toEqual({ files: ["a"] });
    const commit = openGitActionForm("commit", ctx);
    commit.set("message", "Commit index");
    expect(commit.getState().input).toEqual({ message: "Commit index", all: false });
    expect(commit.getState().valid).toBe(true);
    commit.setAll(true);
    expect(commit.getState().input).toEqual({ message: "Commit index", all: true });
    expect(openGitActionForm("commit", ctx).getState().message).toBe("");
  });
  it("requires staging or an explicit commit-all choice", () => {
    const ctx = context();
    ctx.snapshot.files = [{ path: "a", status: " M", conflict: false }];
    const model = openGitActionForm("commit", ctx);
    model.set("message", "Changes");
    expect(model.getState().valid).toBe(false);
    model.setAll(true);
    expect(model.getState().valid).toBe(true);
  });
});

describe("VCS review and file scope", () => {
  it("keeps working reviews across refresh while isolating providers, comparisons and revisions", () => {
    const snapshot = context().snapshot;
    const key = vcsReviewDraftKey("host", "workspace", snapshot, defaultVcsPaneState);
    expect(
      vcsReviewDraftKey("host", "workspace", { ...snapshot, version: "next" }, defaultVcsPaneState),
    ).toBe(key);
    expect(
      vcsReviewDraftKey("host", "workspace", snapshot, {
        ...defaultVcsPaneState,
        comparisonId: "staged",
      }),
    ).not.toBe(key);
    expect(
      vcsReviewDraftKey(
        "host",
        "workspace",
        { ...snapshot, binding: { ...snapshot.binding, providerId: "other" } },
        defaultVcsPaneState,
      ),
    ).not.toBe(key);
    expect(
      vcsReviewDraftKey("host", "workspace", snapshot, {
        ...defaultVcsPaneState,
        selection: { kind: "revision", revision: snapshot.current! },
      }),
    ).not.toBe(key);
  });
  it("expands folders by path boundary and includes both sides of a rename", () => {
    const file = {
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      status: "ok" as const,
      hunks: [],
    };
    expect(
      selectedDiffFiles(
        [
          { ...file, path: "src/new.ts", oldPath: "old.ts" },
          { ...file, path: "src-other/no.ts" },
        ],
        "src",
        "directory",
      ),
    ).toEqual(["src/new.ts", "old.ts"]);
  });
  it("groups status files without diff statistics and preserves collapsed directory identities", () => {
    const files = [
      { path: "z.txt", status: "modified", conflict: false },
      { path: "src/deep/a.ts", previousPath: "old.ts", status: "renamed", conflict: true },
      { path: "src/b.ts", status: "added", conflict: false },
      { path: "src-other/c.ts", status: "deleted", conflict: false },
    ];
    const rows = statusTreeRows(files, ["src/deep"]);
    expect(rows.map(({ kind, path, depth }) => [kind, path, depth])).toEqual([
      ["directory", "src", 0],
      ["directory", "src/deep", 1],
      ["file", "src/b.ts", 1],
      ["directory", "src-other", 0],
      ["file", "src-other/c.ts", 1],
      ["file", "z.txt", 0],
    ]);
    expect(statusTreeRows(files, ["src"]).map((row) => row.path)).toEqual([
      "src",
      "src-other",
      "src-other/c.ts",
      "z.txt",
    ]);
    expect(statusTreeRows(files, []).find((row) => row.path === "src/deep/a.ts")).toMatchObject({
      file: files[1],
    });
    expect(statusTreeRows([], ["src"])).toEqual([]);
  });
  it("selects snapshot file paths without a parsed diff, including rename sources", () => {
    const files = [
      { path: "src/new.ts", previousPath: "old.ts", status: "renamed", conflict: false },
      { path: "src/second.ts", status: "modified", conflict: false },
      { path: "src-other/file.ts", status: "added", conflict: false },
    ];
    expect(selectedDiffFiles(files, "src/new.ts", "file")).toEqual(["src/new.ts", "old.ts"]);
    expect(selectedDiffFiles(files, "src", "directory")).toEqual([
      "src/new.ts",
      "old.ts",
      "src/second.ts",
    ]);
    expect(selectedDiffFiles(files, "missing", "file")).toEqual([]);
  });
  it("seeds Git and jj file forms with only the menu selection", () => {
    const ctx = context();
    ctx.selectedFiles = ["sub/b.txt"];
    ctx.snapshot.files = ctx.files.map((path) => ({ path, status: " M", conflict: false }));
    expect(openGitActionForm("stage", ctx).getState().files).toEqual(["sub/b.txt"]);
    expect(openJjActionForm("restore", ctx).getState().files).toEqual(["sub/b.txt"]);
  });
});

describe("provider-owned base comparisons", () => {
  it("delegates exact revisions and ranges without changing legacy plugins or action forms", () => {
    const { snapshot } = context();
    const selected = { kind: "revision" as const, revision: revision("selected-revision") };
    const state = { ...defaultVcsPaneState, selection: selected };
    const input = { snapshot, state, selection: selected, form: false, ignoreWhitespace: true };
    const plain = { kind: "revision", revision: selected.revision.id };
    expect(resolvePaneComparison(input)).toEqual({ comparison: plain });
    const calls: unknown[] = [];
    const contribution = {
      providerId: "external",
      title: "External",
      actions: [],
      resolveRevisionComparison(
        value: import("@getpaseo/plugin/client").PluginVcsRevisionComparisonInput,
      ) {
        calls.push(value);
        return {
          comparison: {
            kind: "working-copy" as const,
            data: { version: 7, data: value.comparison },
          },
          reviewScope: "external-scope",
        };
      },
    };
    expect(resolvePaneComparison({ ...input, contribution })).toMatchObject({
      comparison: { data: { version: 7, data: plain } },
      reviewScope: "external-scope",
    });
    const range = { from: "exact-from", to: "exact-to" };
    expect(
      resolvePaneComparison({
        ...input,
        contribution,
        selection: { kind: "workspace" },
        state: { ...state, range },
      }),
    ).toMatchObject({
      comparison: { data: { data: { kind: "range", ...range } } },
    });
    expect(resolvePaneComparison({ ...input, contribution, form: true })).toEqual({
      comparison: plain,
    });
    expect(
      resolvePaneComparison({
        ...input,
        contribution,
        selection: {
          kind: "ref",
          revision: null,
          ref: { id: "conflict", name: "conflict", kind: "bookmark", targets: ["one", "two"] },
        },
      }),
    ).toEqual({ comparison: null });
    expect(calls).toEqual([
      { snapshot, comparison: plain, ignoreWhitespace: true },
      { snapshot, comparison: { kind: "range", ...range }, ignoreWhitespace: true },
    ]);
  });
  it("keeps comparison selections JSON-persistable when leaving a range or inheriting a base", () => {
    const snapshot = context().snapshot;
    const range = selectWorkspaceComparison(defaultVcsPaneState, "range", snapshot.current);
    expect(range.range).toEqual({ from: snapshot.current!.parents[0], to: snapshot.current!.id });
    const selected = selectComparisonBase(
      selectWorkspaceComparison(range, "base", snapshot.current),
      "bookmark-id",
    );
    expect(selected).not.toHaveProperty("range");
    expect(z.json().safeParse(selected).success).toBe(true);
    const inherited = selectComparisonBase(selected, "");
    expect(inherited).not.toHaveProperty("baseRef");
    expect(z.json().safeParse(inherited).success).toBe(true);
  });
  it("pins jj bookmark comparisons and blocks conflicted or missing targets", () => {
    const snapshot = context().snapshot;
    const base = "a".repeat(40);
    const ref = { id: '["main",null]', name: "main", kind: "bookmark", targets: [base] };
    snapshot.refs = [ref];
    const input = { snapshot, id: "base", baseRef: ref.id, ignoreWhitespace: false };
    const result = resolveJjComparison(input);
    expect(result.comparison).toEqual({
      kind: "working-copy",
      data: {
        version: 1,
        data: {
          operation: snapshot.version,
          revision: snapshot.current!.id,
          base,
          ignoreWhitespace: false,
        },
      },
    });
    expect(resolveJjComparison({ ...input, ignoreWhitespace: true }).reviewScope).not.toBe(
      result.reviewScope,
    );
    const current = resolveJjComparison({ ...input, id: "default" });
    expect(current.selectBase).toBe(false);
    expect(current.comparison).toMatchObject({
      data: { data: { revision: snapshot.current!.id } },
    });
    expect(current.reviewScope).not.toBe(result.reviewScope);
    expect(
      vcsReviewDraftKey("host", "workspace", snapshot, defaultVcsPaneState, current.reviewScope),
    ).toBe(vcsReviewDraftKey("host", "workspace", snapshot, defaultVcsPaneState));
    expect(resolveJjComparison({ ...input, baseRef: undefined }).comparison).toBeNull();
    expect(resolveJjComparison({ ...input, baseRef: "main" }).comparison).toBeNull();
    ref.targets = [base, "b".repeat(40)];
    expect(resolveJjComparison(input).comparison).toBeNull();
    ref.targets = ["b".repeat(40)];
    expect(result.comparison).toMatchObject({ data: { data: { base } } });
    expect(resolveJjComparison(input).comparison).toMatchObject({
      data: { data: { base: "b".repeat(40) } },
    });
    expect(resolveJjComparison({ ...input, id: "missing" }).comparison).toBeNull();
    expect(
      resolveJjComparison({ ...input, snapshot: { ...snapshot, current: null } }).comparison,
    ).toBeNull();
  });
  it("accepts exact base revisions without refs and keeps named refs authoritative", () => {
    const snapshot = context().snapshot;
    snapshot.refs = [];
    const base = "a".repeat(40);
    const input = { snapshot, id: "committed", baseRef: base, ignoreWhitespace: false };
    expect(resolveGitComparison(input).comparison).toMatchObject({
      data: { data: { base, version: snapshot.version } },
    });
    expect(resolveGitComparison({ ...input, baseRef: "a".repeat(64) }).comparison).not.toBeNull();
    expect(resolveGitComparison({ ...input, baseRef: "aaaaaaa" }).comparison).toBeNull();
    expect(resolveGitComparison({ ...input, baseRef: "a".repeat(41) }).comparison).toBeNull();
    expect(resolveGitComparison({ ...input, baseRef: "HEAD~1" }).comparison).toBeNull();
    snapshot.refs = [
      { id: `refs/heads/${base}`, name: base, kind: "branch", targets: ["b".repeat(40)] },
    ];
    expect(resolveGitComparison(input).comparison).toMatchObject({
      data: { data: { base: "b".repeat(40) } },
    });
    snapshot.refs.push({
      id: `refs/tags/${base}`,
      name: base,
      kind: "tag",
      targets: ["c".repeat(40)],
    });
    expect(resolveGitComparison(input).comparison).toBeNull();
  });
  it("opens a tree comparison once without replacing a later selection or another provider", () => {
    const request = {
      requestId: "open-1",
      providerId: "git",
      selection: { kind: "workspace" as const },
      comparisonId: "committed",
      baseRef: "refs/heads/main",
    };
    const state = { ...defaultVcsPaneState, view: "history" };
    const opened = applyComparisonRequest(state, request, "git");
    expect(z.json().safeParse(opened).success).toBe(true);
    expect(opened).toMatchObject({
      view: "changes",
      comparisonId: "committed",
      baseRef: "refs/heads/main",
      consumedComparisonRequestId: "open-1",
    });
    const edited = { ...opened, comparisonId: "staged" };
    expect(applyComparisonRequest(edited, request, "git")).toBe(edited);
    expect(applyComparisonRequest(state, request, "external")).toBe(state);
    const cleared = applyComparisonRequest(
      { ...opened, range: { from: "old-base", to: "old-head" } },
      { requestId: "open-2", providerId: "git", selection: { kind: "workspace" } },
      "git",
    );
    expect(cleared).not.toHaveProperty("comparisonId");
    expect(cleared).not.toHaveProperty("baseRef");
    expect(cleared).not.toHaveProperty("range");
    expect(z.json().safeParse(cleared).success).toBe(true);
  });
  it("resolves inherited views to pinned targets and keeps review scopes distinct", () => {
    const snapshot = context().snapshot;
    const base = "a".repeat(40);
    snapshot.refs = [{ id: "refs/heads/main", name: "main", kind: "branch", targets: [base] }];
    const input = {
      snapshot,
      defaults: { version: 1, data: { mode: "all", baseRef: "main", error: null, warning: null } },
      ignoreWhitespace: false,
    };
    const result = resolveGitComparison(input);
    expect(result.comparison).toEqual({
      kind: "working-copy",
      data: {
        version: 2,
        data: { version: snapshot.version, mode: "combined", base, ignoreWhitespace: false },
      },
    });
    expect(resolveGitComparison({ ...input, id: "committed" }).reviewScope).not.toBe(
      result.reviewScope,
    );
    expect(resolveGitComparison({ ...input, ignoreWhitespace: true }).reviewScope).not.toBe(
      result.reviewScope,
    );
    expect(resolveGitComparison({ ...input, id: "all" }).selectBase).toBe(false);
    snapshot.refs.push({
      id: "refs/tags/main",
      name: "main",
      kind: "tag",
      targets: ["b".repeat(40)],
    });
    expect(resolveGitComparison(input).comparison).toBeNull();
    expect(
      resolveGitComparison({ ...input, baseRef: "refs/heads/main" }).comparison,
    ).not.toBeNull();
    expect(resolveGitComparison({ ...input, baseRef: "missing" }).error).toContain("unavailable");
  });
  it("opens a saved legacy review in the inherited comparison without losing a pending operation", () => {
    const operation = {
      providerId: "git",
      id: "pending-operation",
      request: {
        kind: "action",
        action: "commit",
        version: "snapshot",
        input: { message: "Commit" },
      },
    };
    const state = {
      ...defaultChangesState,
      gitLegacyReview: true,
      vcs: {
        ...defaultVcsPaneState,
        view: "history",
        comparisonId: "staged",
        baseRef: "main",
        range: { from: "base", to: "head" },
        operation,
      },
    };
    expect(changesStateSchema.parse(state)).toMatchObject({
      vcs: { view: "changes", selection: { kind: "workspace" }, operation },
    });
    expect(changesStateSchema.parse(state).vcs).not.toHaveProperty("comparisonId");
    expect(changesStateSchema.parse(state).vcs).not.toHaveProperty("baseRef");
    expect(changesStateSchema.parse(state).vcs).not.toHaveProperty("range");
    expect(changesStateSchema.parse(state)).not.toHaveProperty("gitLegacyReview");
    expect(z.json().safeParse(changesStateSchema.parse(state)).success).toBe(true);
  });
});

describe("existing change request discovery", () => {
  const target: VcsPublication = {
    remote: "origin",
    repositoryUrl: "https://forge.test/project",
    headRef: "task",
    baseRef: "main",
    headRevision: "exact-revision",
  };
  function selected() {
    const model = openPublicationForm();
    model.set("remote", "origin", "Selected remote");
    model.set("headRef", "task", "Selected bookmark");
    model.set("baseRef", " main ");
    return model;
  }
  it("looks up without a title and restores the selected target only for its working copy", async () => {
    const model = selected();
    expect(model.getState()).toMatchObject({ canLookup: true, canSubmit: false });
    await model.lookup(async (selection) => {
      expect(selection).toEqual({ remote: "origin", headRef: "task", baseRef: "main" });
      return target;
    });
    const identity = publicationIdentity(context().snapshot.binding);
    const pane = vcsPaneStateSchema.parse(
      JSON.parse(
        JSON.stringify({ ...defaultVcsPaneState, publication: { ...model.getDraft(), identity } }),
      ),
    );
    const restored = openPublicationForm(restorePublicationFields(pane, identity));
    expect(restored.getState()).toMatchObject({
      target,
      remoteLabel: "Selected remote",
      headLabel: "Selected bookmark",
      canSubmit: false,
    });
    expect(restorePublicationFields(pane, "another-working-copy")).toBeUndefined();
    restored.set("baseRef", "release");
    expect(restored.getState().target).toBeNull();
  });
  it("ignores a lookup completed after changing references or closing the form", async () => {
    const model = selected();
    let finish!: (target: VcsPublication) => void;
    const first = model.lookup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(model.getState()).toMatchObject({ canLookup: false, lookup: { status: "pending" } });
    model.set("headRef", "second");
    const second = { ...target, headRef: "second", headRevision: "new-revision" };
    await model.lookup(async () => second);
    finish(target);
    await first;
    expect(model.getState().target).toEqual(second);
    const late = model.lookup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    model.close();
    finish(second);
    await late;
    expect(model.getDraft().target).toBeNull();
  });
  it("reports lookup failures and rejects a provider's mismatched target", async () => {
    const model = selected();
    await model.lookup(async () => {
      throw new Error("Remote unavailable");
    });
    expect(model.getState()).toMatchObject({
      target: null,
      canLookup: true,
      lookup: { status: "failed", message: "Remote unavailable" },
    });
    await model.lookup(async () => ({ ...target, remote: "unselected" }));
    expect(model.getState().lookup.status).toBe("failed");
    expect(model.getState().target).toBeNull();
    await model.lookup(async () => target);
    expect(model.getState()).toMatchObject({ target, lookup: { status: "idle" } });
  });
  it("never shows a creation URL from another publication or after status validation fails", () => {
    const result = {
      publication: target,
      stage: "created",
      changeRequest: { number: 7, url: "https://forge.test/project/pull/7" },
    };
    const input = { data: { status: null }, error: null, isPending: false, result, target };
    expect(publicationStatusView(input).requestUrl).toBe(result.changeRequest.url);
    expect(
      publicationStatusView({ ...input, target: { ...target, headRevision: "another" } }),
    ).toMatchObject({ requestUrl: undefined, empty: true });
    expect(publicationStatusView({ ...input, error: new Error("Target changed") })).toMatchObject({
      status: undefined,
      requestUrl: undefined,
      empty: false,
    });
  });
});

it("validates provider options before allocating an intent but looks up uncertain intents unchanged", async () => {
  const snapshot = context().snapshot;
  const model = openWorkingCopyForm({
    projectId: "project",
    binding: snapshot.binding,
    revision: snapshot.current,
  });
  const create = vi.fn().mockRejectedValue(new Error("Disconnected"));
  const id = vi.fn(() => "intent");
  await model.submit({ id, create, validate: () => "Invalid workspace name" });
  expect(model.getState()).toMatchObject({
    intent: null,
    status: "idle",
    error: "Invalid workspace name",
  });
  expect(id).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  await model.submit({
    id,
    create,
    validate: () => {
      throw new Error("Plugin validation failed");
    },
  });
  expect(model.getState()).toMatchObject({
    intent: null,
    status: "idle",
    error: "Plugin validation failed",
  });
  expect(create).not.toHaveBeenCalled();
  await model.submit({ id, create, validate: () => null });
  const changedValidator = vi.fn(() => "Plugin changed");
  await model.submit({ id, create, validate: changedValidator });
  expect(changedValidator).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
});

it("keeps contributed project sources scoped, copied and unavailable until selected", () => {
  const model = openIsolationForm();
  const snapshot = context().snapshot;
  snapshot.capabilities = ["working-copies"];
  snapshot.actions = [{ id: "working-copy.create", enabled: true }];
  model.apply("host/project", { status: "loaded", snapshot });
  expect(() => model.source("host/project", "project", true)).toThrow("Select a source");
  const source = {
    kind: "working-copy" as const,
    providerId: "external",
    projectId: "project",
    cwd: "/repo/sub",
    revision: "exact",
  };
  model.setProjectSource("host/project", source);
  source.revision = "mutated";
  expect(model.source("host/project", "project", true)).toMatchObject({ revision: "exact" });
  model.apply("host/project", { status: "loaded", snapshot: { ...snapshot, version: "refresh" } });
  expect(model.source("host/project", "project", true)).toMatchObject({ revision: "exact" });
  model.setProjectSource("host/project", { ...source, cwd: "/another" });
  expect(() => model.source("host/project", "project", true)).toThrow("no longer matches");
  model.apply("other/project", { status: "loaded", snapshot });
  expect(model.isCurrent("host/project", snapshot)).toBe(false);
  expect(model.isCurrent("other/project", snapshot)).toBe(true);
  expect(
    model.isCurrent("other/project", {
      ...snapshot,
      binding: { ...snapshot.binding, providerId: "changed" },
    }),
  ).toBe(false);
  model.setProjectSource("host/project", source);
  expect(() => model.source("other/project", "project", true)).toThrow("Select a source");
});

it("lets the Git contribution own upstream selection, branch validation and forge checkout", async () => {
  const snapshot = context().snapshot;
  snapshot.binding.providerId = "git";
  snapshot.data = {
    version: 1,
    data: { branch: "main", upstreamRef: "refs/remotes/upstream/trunk" },
  };
  snapshot.refs = [
    { id: "refs/heads/main", name: "main", kind: "branch", targets: ["local"] },
    {
      id: "refs/remotes/upstream/trunk",
      name: "upstream/trunk",
      kind: "remote-branch",
      targets: ["remote"],
    },
  ];
  const onChange = vi.fn();
  const model = openProjectSource({
    context: { snapshot, projectId: "project" },
    value: null,
    onChange,
    resolve: async (selection) => ({
      revision: "a".repeat(40),
      data: {
        version: 2,
        data: {
          source:
            selection.kind === "branch"
              ? selection
              : {
                  kind: "change-request",
                  repositoryUrl: "https://example.test/owner/repo",
                  target: {
                    forge: selection.forge,
                    changeRequestNumber: selection.number,
                    headRef: "fix",
                    baseRefName: "main",
                    checkoutRefs: [{ remoteRef: "refs/merge-requests/7/head" }],
                  },
                  fetch: {
                    url: "https://example.test/owner/repo",
                    ref: "refs/merge-requests/7/head",
                  },
                },
        },
      },
    }),
  });
  model.activate();
  await vi.waitFor(() => expect(model.getState().preparation.status).toBe("ready"));
  expect(onChange).toHaveBeenLastCalledWith(
    {
      kind: "working-copy",
      projectId: "project",
      providerId: "git",
      cwd: "/repo/sub",
      revision: "a".repeat(40),
      providerData: {
        version: 2,
        data: { source: { kind: "branch", ref: "refs/remotes/upstream/trunk" } },
      },
    },
    [],
  );
  model.setBranch("../invalid");
  expect(onChange).toHaveBeenLastCalledWith(null);
  model.setBranch("main");
  expect(model.getState().branchExists).toBe(true);
  expect(onChange).toHaveBeenLastCalledWith(null);
  model.setBranch("feature/new");
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    providerData: { data: { branch: "feature/new" } },
  });
  await model.search(async () => {
    throw new Error("Forge unavailable");
  });
  expect(model.getState().error).toBe("Forge unavailable");
  const request = {
    kind: "change_request" as const,
    forge: "gitlab",
    number: 7,
    title: "Fix",
    url: "https://example.test/owner/repo/-/merge_requests/7",
    state: "open",
    body: "Description",
    labels: [],
    headRefName: "fix",
    projectPath: "owner/repo",
  };
  await model.search(async () => [request]);
  expect(model.getState().error).toBeNull();
  model.select("request:gitlab:7");
  expect(onChange.mock.lastCall?.[0]).toBeNull();
  await vi.waitFor(() => expect(model.getState().preparation.status).toBe("ready"));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    kind: "working-copy",
    projectId: "project",
    cwd: "/repo/sub",
    providerId: "git",
    revision: "a".repeat(40),
    providerData: {
      version: 2,
      data: {
        source: { kind: "change-request", target: { forge: "gitlab", changeRequestNumber: 7 } },
      },
    },
  });
  expect(onChange.mock.lastCall?.[1]).toEqual([
    expect.objectContaining({
      type: "forge_change_request",
      forge: "gitlab",
      number: 7,
      body: "Description",
    }),
  ]);
  let resolve!: (items: (typeof request)[]) => void;
  const pending = model.search(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  model.close();
  onChange.mockClear();
  resolve([request]);
  await pending;
  model.select("refs/heads/main");
  expect(onChange).not.toHaveBeenCalled();
});

it("ignores late Git source previews and blocks creation until an explicit retry succeeds", async () => {
  type Prepared = import("../../../../plugins/git-vcs/shared/working-copy.js").ResolvedSource;
  const snapshot = context().snapshot;
  snapshot.binding.providerId = "git";
  snapshot.data = { version: 1, data: { branch: "main" } };
  snapshot.refs = ["main", "other"].map((name) => ({
    id: `refs/heads/${name}`,
    name,
    kind: "branch",
    targets: ["a".repeat(40)],
  }));
  const previews: { resolve(value: Prepared): void; reject(error: Error): void }[] = [];
  const resolve = vi.fn(
    () =>
      new Promise<Prepared>((done, reject) => {
        previews.push({ resolve: done, reject });
      }),
  );
  const onChange = vi.fn();
  const model = openProjectSource({
    context: { snapshot, projectId: "project" },
    value: null,
    onChange,
    resolve,
  });
  const prepared = (ref: string): Prepared => ({
    revision: "a".repeat(40),
    data: { version: 2, data: { source: { kind: "branch", ref } } },
  });
  model.activate();
  model.select("refs/heads/other");
  previews[1]!.reject(new Error("remote unavailable"));
  await vi.waitFor(() => expect(model.getState().preparation.status).toBe("error"));
  previews[0]!.resolve(prepared("refs/heads/main"));
  await Promise.resolve();
  expect(model.getState().preparation.status).toBe("error");
  expect(onChange.mock.lastCall?.[0]).toBeNull();
  model.setBranch("new-branch");
  expect(resolve).toHaveBeenCalledTimes(2);
  model.retrySource();
  previews[2]!.resolve(prepared("refs/heads/other"));
  await vi.waitFor(() =>
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      providerData: { data: { branch: "new-branch", source: { ref: "refs/heads/other" } } },
    }),
  );
  model.setBranch("another-name");
  expect(resolve).toHaveBeenCalledTimes(3);
  model.select("refs/heads/main");
  model.close();
  onChange.mockClear();
  previews[3]!.resolve(prepared("refs/heads/main"));
  await Promise.resolve();
  expect(onChange).not.toHaveBeenCalled();
});

it("retains a publication target whose local and remote refs have different names", async () => {
  const form = openPublicationForm();
  form.set("remote", "fork");
  form.set("headRef", "alice/feature");
  form.set("baseRef", "main");
  const target: VcsPublication = {
    remote: "fork",
    repositoryUrl: "https://example.test/fork",
    headRef: "feature",
    headRevision: "commit",
    baseRef: "main",
    selection: { remote: "fork", headRef: "alice/feature", baseRef: "main" },
    data: { version: 1, data: { localBranch: "alice/feature" } },
  };
  await form.lookup(async () => target);
  expect(form.getState()).toMatchObject({
    lookup: { status: "idle" },
    target,
    headRef: "alice/feature",
  });
  const state = vcsPaneStateSchema.parse({
    ...defaultVcsPaneState,
    publication: { ...form.getDraft(), identity: "copy" },
  });
  expect(restorePublicationFields(state, "copy")?.target).toEqual(target);
  form.set("headRef", "another-branch");
  expect(form.getState().target).toBeNull();
});

describe("persisted comparison settings", () => {
  it("keeps drafts on validation failure, prevents duplicate saves and resets to inheritance", async () => {
    const { openComparisonSettings } = await import("./comparison-settings-model");
    const inherited = { version: 1, data: { mode: "base", baseRef: "main" } };
    const settings = { providerId: "jj", selection: null, inherited, effective: inherited };
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Select a bookmark"))
      .mockResolvedValue(settings);
    const form = openComparisonSettings({ settings, save });
    const draft = { version: 1, data: { mode: "base", baseRef: "" } };
    form.change(draft);
    const pending = form.save();
    await form.save();
    await pending;
    expect(save).toHaveBeenCalledTimes(1);
    expect(form.getState()).toMatchObject({
      value: draft,
      error: "Select a bookmark",
      saved: false,
    });
    await form.save(true);
    expect(save).toHaveBeenLastCalledWith(null);
    expect(form.getState()).toMatchObject({ value: inherited, saved: true, error: null });
    form.close();
    await form.save();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("resolves jj saved bookmark settings against the current snapshot and respects explicit overrides", () => {
    const snapshot = context().snapshot;
    snapshot.refs = [
      { id: "local:main", name: "main", kind: "bookmark", targets: ["2".repeat(40)] },
    ];
    const input = {
      snapshot,
      defaults: { version: 1, data: { mode: "base", baseRef: "local:main" } },
      ignoreWhitespace: false,
    };
    expect(resolveJjComparison(input)).toMatchObject({
      baseRef: "local:main",
      selectBase: true,
      comparison: { data: { data: { base: "2".repeat(40) } } },
    });
    expect(resolveJjComparison({ ...input, id: "change" })).toMatchObject({ selectBase: false });
    snapshot.refs[0]!.targets.push("3".repeat(40));
    expect(resolveJjComparison(input)).toMatchObject({
      comparison: null,
      error: expect.stringContaining("unambiguous"),
    });
  });
});

it("Git resolves raw saved settings with provider snapshot bases and preserves explicit origin precedence", () => {
  const snapshot = context().snapshot;
  snapshot.refs = [
    { id: "refs/heads/main", name: "main", kind: "branch", targets: ["2".repeat(40)] },
    {
      id: "refs/remotes/origin/main",
      name: "origin/main",
      kind: "remote-branch",
      targets: ["3".repeat(40)],
    },
  ];
  snapshot.data = {
    version: 1,
    data: { comparisonBase: { baseRef: "refs/heads/main", error: null, warning: "Forge offline" } },
  };
  expect(resolveGitComparison({ snapshot, ignoreWhitespace: false })).toMatchObject({
    baseRef: "refs/heads/main",
    warning: "Forge offline",
    comparison: { data: { data: { mode: "combined", base: "2".repeat(40) } } },
  });
  expect(
    resolveGitComparison({
      snapshot,
      ignoreWhitespace: false,
      defaults: { version: 1, data: { mode: "base", baseRef: "main" } },
    }),
  ).toMatchObject({
    baseRef: "origin/main",
    warning: undefined,
    comparison: { data: { data: { mode: "committed", base: "3".repeat(40) } } },
  });
});

it("legacy Git review keys follow the provider base while old descriptor facts catch up", async () => {
  const { legacyGitReviewKey } = await import("./git-comparison-compat");
  const { buildReviewDraftKey } = await import("@/review/store");
  const workspace = {
    id: "w",
    workspaceDirectory: "/repo",
    vcsProviderId: "git",
    diffComparisonV2: { mode: "all" },
    diffComparisonResolvedBase: "old-base",
  } as Parameters<typeof legacyGitReviewKey>[0]["workspace"];
  expect(
    legacyGitReviewKey({
      serverId: "host",
      workspace,
      state: defaultVcsPaneState,
      ignoreWhitespace: false,
      reviewScope: JSON.stringify(["combined", "refs/remotes/upstream/trunk", false]),
    }),
  ).toBe(
    buildReviewDraftKey({
      serverId: "host",
      workspaceId: "w",
      cwd: "/repo",
      mode: "all",
      baseRef: "refs/remotes/upstream/trunk",
      ignoreWhitespace: false,
    }),
  );
  expect(
    legacyGitReviewKey({
      serverId: "host",
      workspace,
      state: defaultVcsPaneState,
      ignoreWhitespace: false,
      reviewScope: "invalid",
    }),
  ).toBeUndefined();
});

it("Git legacy base metadata preserves a named remote instead of substituting the local branch", async () => {
  const { resolveGitBaseName } = await import("../../../../plugins/git-vcs/shared/comparison");
  const refs = [{ id: "refs/heads/main" }, { id: "refs/remotes/origin/main" }];
  expect(resolveGitBaseName(refs, "main", true)).toBe("refs/heads/main");
  expect(resolveGitBaseName(refs, "origin/main", true)).toBe("origin/main");
});
