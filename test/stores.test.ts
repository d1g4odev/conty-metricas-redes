import { describe, expect, it } from "vitest";
import { MetricsStore, type MetricObservation } from "../src/domain/stores.js";

const observation = (overrides: Partial<MetricObservation> = {}): MetricObservation => ({
  connectionId: "conn_1",
  postId: "post_a",
  date: "2026-03-05",
  views: 100,
  likes: 10,
  comments: 1,
  shares: 0,
  providerUpdatedAt: "2026-03-05T00:00:00.000Z",
  fetchedAt: "2026-03-31T12:00:00.000Z",
  syncRunId: "run_1",
  ...overrides,
});

describe("MetricsStore", () => {
  it("upserts by connection, post and day", () => {
    const store = new MetricsStore();

    expect(store.upsert(observation())).toBe("inserted");
    expect(store.upsert(observation({ fetchedAt: "2026-03-31T13:00:00.000Z", syncRunId: "run_2" }))).toBe("unchanged");
    expect(store.upsert(observation({ connectionId: "conn_2" }))).toBe("inserted");
    expect(store.count()).toBe(2);
    expect(store.list("conn_1", { from: "2026-03-01", to: "2026-03-31" })[0]).toMatchObject({
      fetchedAt: "2026-03-31T13:00:00.000Z",
      firstFetchedAt: "2026-03-31T12:00:00.000Z",
      syncRunId: "run_2",
    });
  });

  it("ignores an older provider version that arrives after a newer one", () => {
    const store = new MetricsStore();
    store.upsert(observation({ views: 500, providerUpdatedAt: "2026-03-31T10:00:00.000Z" }));

    const outcome = store.upsert(
      observation({ views: 120, providerUpdatedAt: "2026-03-30T10:00:00.000Z", fetchedAt: "2026-03-31T14:00:00.000Z" }),
    );

    expect(outcome).toBe("stale");
    expect(store.list("conn_1", { from: "2026-03-05", to: "2026-03-05" })[0]).toMatchObject({
      views: 500,
      fetchedAt: "2026-03-31T12:00:00.000Z",
    });
  });

  it("replaces values when the provider revises a day", () => {
    const store = new MetricsStore();
    store.upsert(observation());

    expect(store.upsert(observation({ views: 180, providerUpdatedAt: "2026-03-06T00:00:00.000Z" }))).toBe("updated");
    expect(store.list("conn_1", { from: "2026-03-05", to: "2026-03-05" }).map((row) => row.views)).toEqual([180]);
  });
});
