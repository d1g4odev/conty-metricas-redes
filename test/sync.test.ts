import { describe, expect, it } from "vitest";
import { buildMetricsReport } from "../src/domain/metrics-report.js";
import { ConnectionRateLimitedError, SyncInProgressError } from "../src/domain/sync-service.js";
import { ACCOUNT, createHarness, NOW } from "./support/harness.js";

const MONTH = { from: "2026-03-01", to: "2026-03-31" } as const;
const EXPECTED_ROWS = 31 + 22 + 12;

function baselineTotals() {
  const { sync, report, connection } = createHarness();
  return sync(MONTH.from, MONTH.to).then(() => buildMetricsReport(connection.id, MONTH, report(MONTH.from, MONTH.to)).totals);
}

describe("sync idempotency", () => {
  it("syncing the same window twice stores each post-day once and keeps totals", async () => {
    const h = createHarness();
    const first = await h.sync(MONTH.from, MONTH.to);
    const totalsAfterFirst = buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals;
    const second = await h.sync(MONTH.from, MONTH.to);

    expect(first.status).toBe("succeeded");
    expect(first.stats).toMatchObject({ received: EXPECTED_ROWS, inserted: EXPECTED_ROWS, updated: 0 });
    expect(second.status).toBe("succeeded");
    expect(second.stats).toMatchObject({ received: EXPECTED_ROWS, inserted: 0, updated: 0, unchanged: EXPECTED_ROWS });
    expect(h.context.metrics.count()).toBe(EXPECTED_ROWS);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(totalsAfterFirst);
  });

  it("overlapping windows never double count", async () => {
    const expected = await baselineTotals();
    const h = createHarness();

    await h.sync("2026-03-01", "2026-03-20");
    await h.sync("2026-03-15", "2026-03-31");
    await h.sync("2026-03-10", "2026-03-25");

    expect(h.context.metrics.count()).toBe(EXPECTED_ROWS);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(expected);
  });

  it("duplicated items inside a response are counted once", async () => {
    const expected = await baselineTotals();
    const h = createHarness();
    h.simulator.injectFaults({ kind: "duplicate_items" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.stats.duplicates).toBe(10);
    expect(run.stats.inserted).toBe(EXPECTED_ROWS);
    expect(h.context.metrics.count()).toBe(EXPECTED_ROWS);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(expected);
  });

  it("a replayed page response is detected, not ingested, and the page is requested again", async () => {
    const expected = await baselineTotals();
    const h = createHarness();
    h.simulator.injectFaults({ kind: "ok" }, { kind: "duplicate_page" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.stats).toMatchObject({ replayedPages: 1, duplicates: 10, inserted: EXPECTED_ROWS, received: EXPECTED_ROWS });
    expect(run.waits).toEqual([{ reason: "replayed_page", ms: 500 }]);
    expect(h.simulator.calls[1]?.cursor).toBe(h.simulator.calls[2]?.cursor);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(expected);
  });

  it("records when each metric was fetched and keeps the first fetch time on refresh", async () => {
    const h = createHarness();
    await h.sync(MONTH.from, MONTH.to);
    await h.clock.advance(6 * 3_600_000);
    h.simulator.revise(ACCOUNT, "post_a", "2026-03-05", { views: 999_999 });
    const refresh = await h.sync("2026-03-05", "2026-03-05");

    const [revised] = h.report("2026-03-05", "2026-03-05").filter((row) => row.postId === "post_a");
    const untouched = h.report("2026-03-06", "2026-03-06").find((row) => row.postId === "post_a");

    expect(refresh.stats).toMatchObject({ updated: 1, inserted: 0 });
    expect(revised).toMatchObject({
      views: 999_999,
      firstFetchedAt: NOW,
      fetchedAt: "2026-03-31T18:00:00.000Z",
      providerUpdatedAt: "2026-03-31T18:00:00.000Z",
      syncRunId: refresh.id,
    });
    expect(untouched).toMatchObject({ fetchedAt: NOW, firstFetchedAt: NOW });
  });

  it("rejects malformed rows without failing the sync", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "malformed_row" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.stats.rejected).toBe(1);
    expect(h.context.metrics.count()).toBe(EXPECTED_ROWS);
  });

  it("refuses a concurrent sync for the same connection", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "timeout" });
    const first = h.context.sync.sync(h.connection.id, MONTH);

    await expect(h.context.sync.sync(h.connection.id, MONTH)).rejects.toBeInstanceOf(SyncInProgressError);
    expect((await h.clock.run(first)).status).toBe("succeeded");
  });

  it("a failed sync keeps partial progress and a rerun completes without double counting", async () => {
    const expected = await baselineTotals();
    const h = createHarness({ policy: { maxAttempts: 2 } });
    h.simulator.injectFaults({ kind: "ok" }, { kind: "ok" }, { kind: "timeout" }, { kind: "timeout" });

    const failed = await h.sync(MONTH.from, MONTH.to);
    expect(failed).toMatchObject({ status: "failed", error: "timeout_attempts_exhausted", pages: 2 });
    expect(h.context.metrics.count()).toBe(20);

    const rerun = await h.sync(MONTH.from, MONTH.to);
    expect(rerun.stats).toMatchObject({ inserted: EXPECTED_ROWS - 20, unchanged: 20 });
    expect(h.context.metrics.count()).toBe(EXPECTED_ROWS);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(expected);
  });
});

describe("rate limit with a controlled clock", () => {
  it("waits exactly the Retry-After seconds before calling the provider again", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "rate_limit", retryAfter: "30" });

    const run = await h.sync(MONTH.from, MONTH.to);

    const [limited, retried] = h.simulator.calls;
    expect(limited).toMatchObject({ status: 429, at: NOW });
    expect(retried).toMatchObject({ status: 200, at: "2026-03-31T12:00:30.000Z", cursor: null });
    expect(run.status).toBe("succeeded");
    expect(run.waits).toEqual([{ reason: "rate_limited", ms: 30_000 }]);
    expect(run.providerCalls).toBe(run.pages + 1);
  });

  it("accepts Retry-After as an HTTP date", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "rate_limit", retryAfter: "Tue, 31 Mar 2026 12:00:45 GMT" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(h.simulator.calls[1]?.at).toBe("2026-03-31T12:00:45.000Z");
  });

  it("never waits longer than the cap and defers the sync instead", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 60_000 } });
    h.simulator.injectFaults({ kind: "rate_limit", retryAfter: "3600" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run).toMatchObject({
      status: "rate_limited",
      error: "retry_after_exceeds_cap",
      retryAt: "2026-03-31T13:00:00.000Z",
      providerCalls: 1,
      waitedMs: 0,
    });
    expect(h.clock.now().toISOString()).toBe(NOW);
    expect(h.context.connections.get(h.connection.id)?.rateLimitedUntil).toBe("2026-03-31T13:00:00.000Z");
  });

  it("does not call the provider again before the deferred Retry-After expires", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 60_000 } });
    h.simulator.injectFaults({ kind: "rate_limit", retryAfter: "3600" });
    await h.sync(MONTH.from, MONTH.to);

    await h.clock.advance(3_599_000);
    await expect(h.sync(MONTH.from, MONTH.to)).rejects.toBeInstanceOf(ConnectionRateLimitedError);
    expect(h.simulator.calls).toHaveLength(1);

    await h.clock.advance(1_000);
    const run = await h.sync(MONTH.from, MONTH.to);
    expect(run.status).toBe("succeeded");
    expect(h.simulator.calls[1]?.at).toBe("2026-03-31T13:00:00.000Z");
    expect(h.context.connections.get(h.connection.id)?.rateLimitedUntil).toBeNull();
  });

  it("caps the number of attempts when the provider keeps answering 429", async () => {
    const h = createHarness({ policy: { maxAttempts: 3 } });
    h.simulator.injectFaults(...Array.from({ length: 5 }, () => ({ kind: "rate_limit" as const, retryAfter: "10" })));

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run).toMatchObject({ status: "rate_limited", error: "rate_limit_attempts_exhausted", providerCalls: 3, waitedMs: 20_000 });
    expect(run.retryAt).toBe("2026-03-31T12:00:30.000Z");
    expect(h.simulator.calls.map((call) => call.at)).toEqual([
      "2026-03-31T12:00:00.000Z",
      "2026-03-31T12:00:10.000Z",
      "2026-03-31T12:00:20.000Z",
    ]);
  });

  it("falls back to capped exponential backoff when Retry-After is missing or invalid", async () => {
    const h = createHarness({ policy: { baseBackoffMs: 1_000, maxBackoffMs: 1_500 } });
    h.simulator.injectFaults({ kind: "rate_limit", retryAfter: null }, { kind: "rate_limit", retryAfter: "soon" }, { kind: "rate_limit", retryAfter: "-5" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.waits.map((wait) => wait.ms)).toEqual([1_000, 1_500, 1_500]);
  });

  it("stops when the total wait budget for one sync would be exceeded", async () => {
    const h = createHarness({ policy: { maxTotalWaitMs: 50_000, maxAttempts: 10 } });
    h.simulator.injectFaults(...Array.from({ length: 3 }, () => ({ kind: "rate_limit" as const, retryAfter: "20" })));

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run).toMatchObject({ status: "rate_limited", error: "wait_budget_exhausted", waitedMs: 40_000, providerCalls: 3 });
  });
});

describe("timeouts and transient failures", () => {
  it("aborts a hung request after the timeout and retries", async () => {
    const expected = await baselineTotals();
    const h = createHarness({ policy: { requestTimeoutMs: 5_000, baseBackoffMs: 500 } });
    h.simulator.injectFaults({ kind: "timeout" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.waits).toEqual([{ reason: "timeout", ms: 500 }]);
    expect(h.simulator.calls[0]?.status).toBe("hung");
    expect(h.simulator.calls[1]?.at).toBe("2026-03-31T12:00:05.500Z");
    expect(h.clock.pendingTimers()).toBe(0);
    expect(buildMetricsReport(h.connection.id, MONTH, h.report(MONTH.from, MONTH.to)).totals).toEqual(expected);
  });

  it("gives up after the maximum number of timeouts", async () => {
    const h = createHarness({ policy: { maxAttempts: 3 } });
    h.simulator.injectFaults({ kind: "timeout" }, { kind: "timeout" }, { kind: "timeout" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run).toMatchObject({ status: "failed", error: "timeout_attempts_exhausted", providerCalls: 3, pages: 0 });
    expect(h.context.metrics.count()).toBe(0);
  });

  it("retries 5xx responses with backoff", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "server_error", status: 502 }, { kind: "server_error" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run.status).toBe("succeeded");
    expect(run.waits).toEqual([
      { reason: "provider_unavailable", ms: 500 },
      { reason: "provider_unavailable", ms: 1_000 },
    ]);
  });

  it("does not retry rejected credentials and flags the connection", async () => {
    const h = createHarness();
    h.simulator.injectFaults({ kind: "unauthorized" });

    const run = await h.sync(MONTH.from, MONTH.to);

    expect(run).toMatchObject({ status: "failed", error: "unauthorized", providerCalls: 1 });
    expect(h.context.connections.get(h.connection.id)?.status).toBe("reauthorization_required");
  });
});
