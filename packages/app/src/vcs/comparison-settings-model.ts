import type { VcsData } from "@getpaseo/protocol/vcs";
import type { VcsComparisonSettings } from "@getpaseo/protocol/vcs-rpc";

export function openComparisonSettings(input: {
  settings: VcsComparisonSettings;
  save(value: VcsData | null): Promise<VcsComparisonSettings>;
}) {
  let active = true;
  let state = {
    value: input.settings.effective,
    pending: false,
    error: null as string | null,
    saved: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    if (!active) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      active = true;
    },
    close() {
      active = false;
      listeners.clear();
    },
    change(value: VcsData) {
      if (!state.pending) publish({ value, saved: false, error: null });
    },
    async save(reset = false) {
      if (!active || state.pending) return;
      publish({ pending: true, error: null, saved: false });
      try {
        const settings = await input.save(reset ? null : state.value);
        publish({ value: settings.effective, pending: false, saved: true });
      } catch (error) {
        publish({ pending: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
