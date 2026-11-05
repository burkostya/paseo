import { LRUCache } from "lru-cache";
import {
  resolveComparisonBase,
  type CheckoutContext,
  type ComparisonBaseResolution,
} from "../../utils/checkout-git.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

/** Remembers the last confirmed PR target while the forge is unavailable. */
class ComparisonBaseResolver {
  private readonly pullRequestBases = new LRUCache<string, string>({ max: 512 });

  async resolve(input: {
    cwd: string;
    explicitBaseRef?: string;
    snapshot: WorkspaceGitRuntimeSnapshot | null;
    context?: CheckoutContext;
  }): Promise<ComparisonBaseResolution> {
    const branch = input.snapshot?.git.currentBranch;
    const key = branch ? JSON.stringify([input.cwd, branch]) : null;
    const forge = input.snapshot?.forge;
    const result = await resolveComparisonBase({
      cwd: input.cwd,
      explicitBaseRef: input.explicitBaseRef,
      pullRequest: forge?.pullRequest,
      forgeError: forge?.error?.message,
      previousPullRequestBase: key ? this.pullRequestBases.get(key) : undefined,
      context: input.context,
    });
    if (key && !forge?.error && !input.explicitBaseRef) {
      if (result.source === "pull_request") this.pullRequestBases.set(key, result.baseRef);
      else this.pullRequestBases.delete(key);
    }
    return result;
  }
}

export const comparisonBaseResolver = new ComparisonBaseResolver();
