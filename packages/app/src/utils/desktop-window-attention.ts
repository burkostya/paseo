import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";

interface DesktopWindowAttentionReporterDependencies {
  getHost?: () => DesktopHostBridge | null;
  warn?: (message: string, error: unknown) => void;
}

export interface DesktopWindowAttentionReporter {
  report(active: boolean): void;
}

export function createDesktopWindowAttentionReporter(
  dependencies: DesktopWindowAttentionReporterDependencies = {},
): DesktopWindowAttentionReporter {
  const getHost = dependencies.getHost ?? getDesktopHost;
  const warn = dependencies.warn ?? console.warn;
  let lastReported: boolean | undefined;

  return {
    report(active: boolean): void {
      if (lastReported === active) {
        return;
      }
      lastReported = active;

      const host = getHost();
      if (host?.platform?.toLowerCase() !== "linux") {
        return;
      }

      const desktopWindow = host.window?.getCurrentWindow?.();
      if (!desktopWindow || typeof desktopWindow.setAttention !== "function") {
        return;
      }

      void desktopWindow.setAttention(active).catch((error) => {
        warn("[desktop-window-attention] Failed to update window attention", error);
      });
    },
  };
}

export const desktopWindowAttentionReporter = createDesktopWindowAttentionReporter();
