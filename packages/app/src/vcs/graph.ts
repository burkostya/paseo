import type { VcsRevision } from "@getpaseo/protocol/vcs";
export function revisionGraph(revisions: readonly VcsRevision[]) {
  let lanes: string[] = [];
  return revisions.map((revision) => {
    let lane = lanes.indexOf(revision.id);
    const incoming = lane >= 0;
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(revision.id);
    }
    const before = [...lanes];
    const after = lanes.filter((id) => id !== revision.id);
    for (const [index, parent] of revision.parents.entries()) {
      if (!after.includes(parent)) after.splice(Math.min(lane + index, after.length), 0, parent);
    }
    const edges = before.flatMap((id, from) =>
      id === revision.id
        ? revision.parents.map((parent) => ({ from, to: after.indexOf(parent), parent }))
        : [{ from, to: after.indexOf(id), parent: id }],
    );
    lanes = after;
    return { lane, incoming, width: Math.max(before.length, after.length, 1), edges };
  });
}
