import { useCallback, useEffect, useRef } from "react";

interface UsePollingOptions {
  enabled?: boolean;
  intervalMs: number;
  pauseWhenHidden?: boolean;
  runImmediately?: boolean;
}

export function usePolling(
  task: (signal: AbortSignal) => Promise<void>,
  {
    enabled = true,
    intervalMs,
    pauseWhenHidden = true,
    runImmediately = true,
  }: UsePollingOptions
) {
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!enabled || inFlightRef.current) return;
    if (pauseWhenHidden && document.visibilityState === "hidden") return;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    inFlightRef.current = true;

    try {
      await task(abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error("轮询任务执行失败:", error);
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      inFlightRef.current = false;
    }
  }, [enabled, pauseWhenHidden, task]);

  useEffect(() => {
    if (!enabled) return;

    if (runImmediately) {
      void run();
    }

    const intervalId = window.setInterval(() => {
      void run();
    }, intervalMs);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void run();
      }
    };

    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      abortControllerRef.current?.abort();
    };
  }, [enabled, intervalMs, pauseWhenHidden, run, runImmediately]);

  return run;
}
