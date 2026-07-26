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
      // 仅当自己仍是当前任务时清理状态：卸载中止后（cleanup 已重置标记并可能
      // 已有新任务在跑）旧任务的 finally 不得覆盖新任务的 in-flight 状态
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
        inFlightRef.current = false;
      }
    }
  }, [enabled, pauseWhenHidden, task]);

  // 立即执行 + 页面重新可见时补拉（不依赖 intervalMs，间隔变化不会触发立即 refetch）
  useEffect(() => {
    if (!enabled) return;

    if (runImmediately) {
      void run();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void run();
      }
    };

    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // 中止在途任务并立即释放 in-flight 标记：否则 StrictMode 开发模式的
      // 卸载/重挂载会让重挂载后的 run() 撞上尚未复位的标记而跳过首拉
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      inFlightRef.current = false;
    };
  }, [enabled, pauseWhenHidden, run, runImmediately]);

  // 定时轮询：intervalMs 变化只重建 interval，不立即 run()
  useEffect(() => {
    if (!enabled) return;

    const intervalId = window.setInterval(() => {
      void run();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, run]);

  return run;
}
