import { useEffect, useState, useSyncExternalStore } from "react";
import type { VcsPaneState } from "./state";
import { openPublicationForm } from "./publication-model";
import { restorePublicationFields } from "./publication-state";

export function usePublicationForm(input: {
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
  identity: string;
}) {
  const [model] = useState(() =>
    openPublicationForm(restorePublicationFields(input.state, input.identity)),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { state: pane, setState, identity } = input;
  useEffect(() => {
    let previous = model.getDraft();
    return model.subscribe(() => {
      const draft = model.getDraft();
      if (draft === previous) return;
      previous = draft;
      setState({ ...pane, publication: { ...draft, identity } });
    });
  }, [model, pane, setState, identity]);
  useEffect(() => () => model.close(), [model]);
  return { model, state };
}
