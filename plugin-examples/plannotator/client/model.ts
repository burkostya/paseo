import type { SourceSelection, ReviewState } from "../shared/review";
export function openReviewForm(initialReview: ReviewState | null) {
  const listeners = new Set<() => void>();
  const revision = initialReview?.revisions.find((item) => item.id === initialReview.revisionId);
  let state = {
    selection: revision?.selection ?? { mode: "task" as const },
    review: initialReview,
  };
  function publish() {
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(mode: SourceSelection["mode"]) {
      state = { ...state, selection: { mode } };
      publish();
    },
    setBase(baseRef: string) {
      state = { ...state, selection: { ...state.selection, baseRef: baseRef || undefined } };
      publish();
    },
    applyReview(review: ReviewState | null) {
      state = { ...state, review };
      publish();
    },
    close() {
      listeners.clear();
    },
  };
}
