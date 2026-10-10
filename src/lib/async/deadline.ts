import { AsyncLocalStorage } from "node:async_hooks";

const deadlineSignalStorage = new AsyncLocalStorage<AbortSignal>();

export class DeadlineExceededError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DeadlineExceededError";
  }
}

export function getCurrentDeadlineSignal(): AbortSignal | undefined {
  return deadlineSignalStorage.getStore();
}

export function runWithDeadlineSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return deadlineSignalStorage.run(signal, operation);
}

export function createDeadlineSignal(
  timeoutMs: number,
  timeoutError: Error,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  const timer = setTimeout(() => controller.abort(timeoutError), Math.max(0, timeoutMs));
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) abortFromParent();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}