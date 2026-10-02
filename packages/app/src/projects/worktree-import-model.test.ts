import { expect, test } from "vitest";
import { openWorktreeImportForm } from "./worktree-import-model";

const row = {
  path: "/repo/worktree",
  branch: "feature",
  head: "abc123",
  unavailable: false,
  workspaceId: null,
  archived: false,
};

test("partial import keeps only failed selections and permits retry", async () => {
  let fail = true;
  const imported: string[] = [];
  const model = openWorktreeImportForm({
    list: async () => ({ worktrees: [row, { ...row, path: "/repo/other" }], error: null }),
    import: async (path) => {
      imported.push(path);
      return path === "/repo/other" && fail
        ? { workspaceId: null, error: "Unavailable" }
        : { workspaceId: path, error: null };
    },
  });
  await model.refresh();
  model.toggle(row.path);
  model.toggle("/repo/other");
  await model.submit();
  expect([...model.getState().selected]).toEqual(["/repo/other"]);
  expect(model.getState().errors).toHaveLength(1);
  fail = false;
  await model.submit();
  expect(imported).toEqual([row.path, "/repo/other", "/repo/other"]);
  expect(model.getState().selected.size).toBe(0);
  expect(model.getState().errors).toEqual([]);
});

test("refresh drops selections that became unavailable or already imported", async () => {
  let worktrees = [row];
  const model = openWorktreeImportForm({
    list: async () => ({ worktrees, error: null }),
    import: async () => ({ workspaceId: "unused", error: null }),
  });
  await model.refresh();
  model.toggle(row.path);
  worktrees = [{ ...row, unavailable: true }];
  await model.refresh();
  expect(model.getState().selected.size).toBe(0);
  model.toggle(row.path);
  expect(model.getState().selected.size).toBe(0);
});

test("late refresh cannot repopulate a closed form", async () => {
  let finish!: (value: { worktrees: (typeof row)[]; error: null }) => void;
  const model = openWorktreeImportForm({
    list: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    import: async () => ({ workspaceId: "unused", error: null }),
  });
  const pending = model.refresh();
  model.close();
  finish({ worktrees: [row], error: null });
  await pending;
  expect(model.getState().worktrees).toEqual([]);
});
