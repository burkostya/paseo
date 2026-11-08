import type { VcsProblem } from "../vcs.js";
export class VcsError extends Error {
  constructor(readonly problem: VcsProblem) {
    super(problem.message);
  }
}

/** The caller must refresh instead of treating an interrupted mutation as failed. */
export class VcsUnknownOutcomeError extends VcsError {}
