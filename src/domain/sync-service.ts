import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import { daysInWindow, isIsoDay, isWithin, toIsoDay, type DateWindow } from "./dates.js";
import type { MetricsProvider, ProviderMetricRow, ProviderPage } from "./provider-port.js";
import { DEFAULT_RETRY_POLICY, ReplayedPageError, decideRetry, type RetryPolicy } from "./retry.js";
import type { ConnectionStore, MetricsStore, SyncRunStore } from "./stores.js";
import { withTimeout } from "./timeout.js";
import type { Connection, SyncRun } from "./types.js";

export interface SyncPolicy extends RetryPolicy {
  maxPages: number;
  maxWindowDays: number;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  ...DEFAULT_RETRY_POLICY,
  maxPages: 200,
  maxWindowDays: 92,
};

export class ConnectionNotFoundError extends Error {
  constructor(readonly connectionId: string) {
    super(`connection ${connectionId} not found`);
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionNotActiveError extends Error {
  constructor(readonly connectionId: string) {
    super(`connection ${connectionId} needs reauthorization`);
    this.name = "ConnectionNotActiveError";
  }
}

export class ConnectionRateLimitedError extends Error {
  constructor(readonly retryAt: Date, readonly now: Date) {
    super(`connection is rate limited until ${retryAt.toISOString()}`);
    this.name = "ConnectionRateLimitedError";
  }
}

export class SyncInProgressError extends Error {
  constructor(readonly connectionId: string) {
    super(`a sync is already running for connection ${connectionId}`);
    this.name = "SyncInProgressError";
  }
}

export class InvalidWindowError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidWindowError";
  }
}

class StopSync extends Error {
  constructor(
    readonly status: "failed" | "rate_limited",
    readonly reason: string,
    readonly retryAt: Date | null,
  ) {
    super(reason);
  }
}

export interface SyncServiceDeps {
  connections: ConnectionStore;
  metrics: MetricsStore;
  runs: SyncRunStore;
  provider: MetricsProvider;
  clock: Clock;
  policy?: Partial<SyncPolicy>;
  newId?: () => string;
}

const cursorKey = (cursor: string | null) => cursor ?? "";

export class SyncService {
  private readonly inFlight = new Set<string>();
  private readonly policy: SyncPolicy;
  private readonly newId: () => string;

  constructor(private readonly deps: SyncServiceDeps) {
    this.policy = { ...DEFAULT_SYNC_POLICY, ...deps.policy };
    this.newId = deps.newId ?? randomUUID;
  }

  validateWindow(window: DateWindow): void {
    if (!isIsoDay(window.from) || !isIsoDay(window.to)) {
      throw new InvalidWindowError("from and to must be valid YYYY-MM-DD dates");
    }
    if (window.from > window.to) throw new InvalidWindowError("from must be on or before to");
    if (window.to > toIsoDay(this.deps.clock.now())) throw new InvalidWindowError("to cannot be in the future");
    if (daysInWindow(window) > this.policy.maxWindowDays) {
      throw new InvalidWindowError(`window cannot exceed ${this.policy.maxWindowDays} days`);
    }
  }

  async sync(connectionId: string, window: DateWindow): Promise<SyncRun> {
    const connection = this.deps.connections.get(connectionId);
    if (!connection) throw new ConnectionNotFoundError(connectionId);
    if (connection.status !== "active") throw new ConnectionNotActiveError(connectionId);
    this.validateWindow(window);
    const now = this.deps.clock.now();
    if (connection.rateLimitedUntil && Date.parse(connection.rateLimitedUntil) > now.getTime()) {
      throw new ConnectionRateLimitedError(new Date(connection.rateLimitedUntil), now);
    }
    if (this.inFlight.has(connectionId)) throw new SyncInProgressError(connectionId);
    this.inFlight.add(connectionId);

    const run = this.deps.runs.save({
      id: this.newId(),
      connectionId,
      window: { ...window },
      status: "running",
      startedAt: now.toISOString(),
      finishedAt: null,
      providerCalls: 0,
      pages: 0,
      waitedMs: 0,
      waits: [],
      stats: { received: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0, duplicates: 0, rejected: 0, replayedPages: 0 },
      retryAt: null,
      error: null,
    });

    try {
      await this.pull(connection, run);
      run.status = "succeeded";
    } catch (error) {
      const stop = error instanceof StopSync ? error : new StopSync("failed", "unexpected_error", null);
      run.status = stop.status;
      run.error = stop.reason;
      run.retryAt = stop.retryAt?.toISOString() ?? null;
    } finally {
      this.inFlight.delete(connectionId);
    }

    const finishedAt = this.deps.clock.now().toISOString();
    run.finishedAt = finishedAt;
    this.deps.connections.save({
      ...connection,
      status: run.error === "unauthorized" ? "reauthorization_required" : connection.status,
      rateLimitedUntil: run.status === "rate_limited" ? run.retryAt : null,
      lastSyncedAt: run.status === "succeeded" ? finishedAt : connection.lastSyncedAt,
    });
    return this.deps.runs.save(run);
  }

  private async pull(connection: Connection, run: SyncRun): Promise<void> {
    const processed = new Set<string>();
    const seenInRun = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      if (run.pages >= this.policy.maxPages) throw new StopSync("failed", "max_pages_exceeded", null);
      const page = await this.fetchPage(connection, run, cursor, processed);
      processed.add(cursorKey(cursor));
      run.pages += 1;
      this.ingest(connection, run, page, seenInRun);
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  private async fetchPage(
    connection: Connection,
    run: SyncRun,
    cursor: string | null,
    processed: Set<string>,
  ): Promise<ProviderPage> {
    const { clock, provider } = this.deps;
    for (let attempt = 1; ; attempt += 1) {
      run.providerCalls += 1;
      let failure: unknown;
      try {
        const page = await withTimeout(clock, this.policy.requestTimeoutMs, (signal) =>
          provider.fetchPostMetrics({
            platform: connection.platform,
            accountId: connection.accountId,
            accessToken: connection.accessToken,
            from: run.window.from,
            to: run.window.to,
            cursor,
            signal,
          }),
        );
        const replayed =
          page.nextCursor !== null && (page.nextCursor === cursor || processed.has(cursorKey(page.nextCursor)));
        if (!replayed) return page;
        run.stats.replayedPages += 1;
        run.stats.duplicates += page.items.length;
        failure = new ReplayedPageError(cursor);
      } catch (error) {
        failure = error;
      }
      const decision = decideRetry(failure, attempt, run.waitedMs, clock.now(), this.policy);
      if (decision.action === "stop") throw new StopSync(decision.status, decision.reason, decision.retryAt);
      run.waitedMs += decision.delayMs;
      run.waits.push({ reason: decision.reason, ms: decision.delayMs });
      await clock.sleep(decision.delayMs);
    }
  }

  private ingest(connection: Connection, run: SyncRun, page: ProviderPage, seenInRun: Set<string>): void {
    const fetchedAt = this.deps.clock.now().toISOString();
    run.stats.rejected += page.rejected;
    for (const row of page.items) {
      run.stats.received += 1;
      if (!this.acceptable(row, run.window)) {
        run.stats.rejected += 1;
        continue;
      }
      const key = JSON.stringify([row.postId, row.date]);
      if (seenInRun.has(key)) run.stats.duplicates += 1;
      seenInRun.add(key);
      const outcome = this.deps.metrics.upsert({
        connectionId: connection.id,
        postId: row.postId,
        date: row.date,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        providerUpdatedAt: row.updatedAt,
        fetchedAt,
        syncRunId: run.id,
      });
      run.stats[outcome] += 1;
    }
  }

  private acceptable(row: ProviderMetricRow, window: DateWindow): boolean {
    return isIsoDay(row.date) && isWithin(row.date, window) && !Number.isNaN(Date.parse(row.updatedAt));
  }
}
