import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolveVcsContribution } from "./contributions";
import { applyViewRequest, vcsViews } from "./views";
import type { VcsPaneState, VcsViewRequest } from "./state";
import type { VcsSnapshot } from "@getpaseo/protocol/vcs";

export function useVcsViewRequest(input: {
  serverId: string;
  active: boolean;
  snapshot?: VcsSnapshot;
  request?: VcsViewRequest;
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
  setError(error: string | null): void;
}) {
  const { t } = useTranslation();
  const installed = useInstalledPlugins();
  const publication = useHostFeature(input.serverId, "vcsPublication");
  const workingCopies = useHostFeature(input.serverId, "vcsWorkingCopySelection");
  useEffect(() => {
    const { request, snapshot, state, setState, setError } = input;
    if (!input.active || !snapshot || !request || request.requestId === state.consumedViewRequestId)
      return;
    try {
      const owner = resolveVcsContribution(installed, input.serverId, snapshot.binding.providerId);
      const available = vcsViews(snapshot, owner?.contribution, () => "", {
        changes: "",
        history: "",
        refs: "",
        publish: "",
        workingCopy: "",
      }).filter(
        (view) =>
          (view.id !== "publish" || publication) && (view.id !== "working-copy" || workingCopies),
      );
      const next = applyViewRequest(state, request, snapshot.binding.providerId, available);
      setState(next.state);
      setError(next.unavailable ? t("vcs.viewUnavailable") : null);
    } catch (error) {
      setState({ ...state, consumedViewRequestId: request.requestId });
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [input, installed, publication, workingCopies, t]);
}
