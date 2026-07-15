export const GATEWAY_ACTIVE_MEMORY_RUNTIME_SHUTDOWN_TIMEOUT_MS = 6_000;

type CloseMemoryRuntime = () => Promise<void> | void;

export type GatewayStopMemoryPreludeParams = {
  readonly runGlobalGatewayStopSafely: () => Promise<void> | void;
  readonly closeMemoryRuntime: CloseMemoryRuntime;
  readonly runClosePrelude: () => Promise<void> | void;
  readonly warn: (message: string) => void;
  readonly timeoutMs?: number;
};

function formatErrorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function closeMemoryRuntimeWithDeadline(params: {
  readonly closeMemoryRuntime: CloseMemoryRuntime;
  readonly warn: (message: string) => void;
  readonly timeoutMs: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const closePromise = Promise.resolve()
    .then(params.closeMemoryRuntime)
    .then(() => "closed" as const);
  closePromise.catch(() => undefined);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([closePromise, timeoutPromise]);
    if (result === "timeout") {
      params.warn(
        `active memory runtime shutdown timed out after ${params.timeoutMs}ms; continuing shutdown`,
      );
    }
  } catch (err: unknown) {
    params.warn(
      `active memory runtime shutdown failed: ${formatErrorDetail(err)}; continuing shutdown`,
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runGatewayStopMemoryPrelude(
  params: GatewayStopMemoryPreludeParams,
): Promise<void> {
  await params.runGlobalGatewayStopSafely();
  await closeMemoryRuntimeWithDeadline({
    closeMemoryRuntime: params.closeMemoryRuntime,
    warn: params.warn,
    timeoutMs: params.timeoutMs ?? GATEWAY_ACTIVE_MEMORY_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  });
  await params.runClosePrelude();
}
