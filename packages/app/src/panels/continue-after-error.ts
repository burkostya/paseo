export type ContinueAfterErrorActionState = "hidden" | "disabled" | "ready" | "sending";

export function createContinueAfterErrorSubmitter(): (
  submit: () => Promise<void>,
) => Promise<boolean> {
  let isSubmitting = false;

  return async (submit) => {
    if (isSubmitting) return false;
    isSubmitting = true;
    try {
      await submit();
      return true;
    } finally {
      isSubmitting = false;
    }
  };
}

export function resolveContinueAfterErrorActionState(input: {
  hasError: boolean;
  isAgentTurnActive: boolean;
  hasPendingPermission: boolean;
  isArchived: boolean;
  isConnected: boolean;
  isSending: boolean;
}): ContinueAfterErrorActionState {
  if (
    !input.hasError ||
    input.isAgentTurnActive ||
    input.hasPendingPermission ||
    input.isArchived
  ) {
    return "hidden";
  }
  if (input.isSending) return "sending";
  return input.isConnected ? "ready" : "disabled";
}
