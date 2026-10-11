export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortedSleepError extends Error {
  constructor() {
    super("sleep aborted");
    this.name = "AbortedSleepError";
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedSleepError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortedSleepError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
