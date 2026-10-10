import { AbortedSleepError, type Clock } from "../../src/domain/clock.js";

interface Timer {
  id: number;
  at: number;
  resolve: () => void;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 0;
  readonly sleeps: number[] = [];

  constructor(start: string) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedSleepError());
        return;
      }
      const id = this.nextId++;
      this.timers.push({ id, at: this.current + ms, resolve });
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((timer) => timer.id !== id);
          reject(new AbortedSleepError());
        },
        { once: true },
      );
    });
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flush();
    for (let timer = this.nextDue(target); timer; timer = this.nextDue(target)) {
      this.fire(timer);
      await flush();
    }
    this.current = target;
  }

  async run<T>(promise: Promise<T>, maxSteps = 1_000): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    tracked.catch(() => undefined);
    for (let step = 0; step < maxSteps; step += 1) {
      await flush();
      if (settled) return tracked;
      const timer = this.nextDue(Number.POSITIVE_INFINITY);
      if (timer) this.fire(timer);
    }
    throw new Error("FakeClock.run: promise did not settle");
  }

  private nextDue(limit: number): Timer | undefined {
    return [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id).find((timer) => timer.at <= limit);
  }

  private fire(timer: Timer): void {
    this.timers = this.timers.filter((t) => t.id !== timer.id);
    this.current = Math.max(this.current, timer.at);
    timer.resolve();
  }
}
