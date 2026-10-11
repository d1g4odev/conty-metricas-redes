import type { Clock } from "./clock.js";

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export async function withTimeout<T>(
  clock: Clock,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = new AbortController();
  const timer = new AbortController();
  const expired = clock.sleep(timeoutMs, timer.signal).then(() => {
    request.abort();
    throw new RequestTimeoutError(timeoutMs);
  });
  expired.catch(() => undefined);
  const work = task(request.signal);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    timer.abort();
  }
}
