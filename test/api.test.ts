import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createContext } from "../src/context.js";
import { buildApp } from "../src/http/app.js";
import { FakeClock } from "./support/fake-clock.js";
import { ACCOUNT, DEFAULT_POSTS, NOW, TOKEN } from "./support/harness.js";

let app: FastifyInstance;

function setup() {
  const clock = new FakeClock(NOW);
  const context = createContext({ clock, pageSize: 10, policy: { maxRetryAfterMs: 60_000 } });
  context.simulator?.addAccount({ platform: "instagram", accountId: ACCOUNT, token: TOKEN, posts: DEFAULT_POSTS });
  app = buildApp(context);
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    clock.run(app.inject({ method, url, ...(payload ? { payload } : {}) }));
  return { clock, context, call };
}

async function connect(call: ReturnType<typeof setup>["call"]) {
  const response = await call("POST", "/connections", { platform: "instagram", accountId: ACCOUNT, accessToken: TOKEN });
  return response.json<{ id: string }>().id;
}

afterEach(async () => {
  await app?.close();
});

describe("HTTP API", () => {
  it("creates a connection without echoing the token", async () => {
    const { call } = setup();

    const response = await call("POST", "/connections", { platform: "instagram", accountId: ACCOUNT, accessToken: TOKEN });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ platform: "instagram", accountId: ACCOUNT, status: "active", tokenHint: "…r-01", createdAt: NOW });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("validates input", async () => {
    const { call } = setup();
    const id = await connect(call);

    const badConnection = await call("POST", "/connections", { platform: "orkut", accountId: "", accessToken: "x" });
    const badWindow = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-10", to: "2026-03-01" });
    const future = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-04-02" });
    const missing = await call("POST", "/connections/nope/syncs", { from: "2026-03-01", to: "2026-03-02" });

    expect(badConnection.statusCode).toBe(400);
    expect(badConnection.json().error.issues.map((issue: { path: string }) => issue.path)).toEqual([
      "platform",
      "accountId",
      "accessToken",
    ]);
    expect(badWindow.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ error: { code: "invalid_window" } });
    expect(missing.statusCode).toBe(404);
  });

  it("syncs overlapping windows and reports totals without double counting", async () => {
    const { call } = setup();
    const id = await connect(call);

    const first = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-20" });
    const second = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-15", to: "2026-03-31" });
    const metrics = await call("GET", `/connections/${id}/metrics?from=2026-03-01&to=2026-03-31`);
    const runs = await call("GET", `/connections/${id}/syncs`);

    expect(first.statusCode).toBe(200);
    expect(second.json().stats).toMatchObject({ unchanged: 6 * 2 + 1, inserted: 65 - (20 + 11 + 1) });
    const report = metrics.json();
    const dayCount = report.posts.reduce((sum: number, post: { days: unknown[] }) => sum + post.days.length, 0);
    expect(dayCount).toBe(65);
    expect(report.posts.map((post: { postId: string }) => post.postId)).toEqual(["post_a", "post_b", "post_c"]);
    expect(report.lastFetchedAt).toBe(NOW);
    expect(report.totals.views).toBe(
      report.posts.reduce((sum: number, post: { totals: { views: number } }) => sum + post.totals.views, 0),
    );
    expect(runs.json().runs).toHaveLength(2);
  });

  it("exposes a deferred rate limit as 202 + Retry-After and then 429 until it expires", async () => {
    const { call, clock } = setup();
    const id = await connect(call);
    await call("POST", "/_simulator/faults", { faults: [{ kind: "rate_limit", retryAfter: "120" }] });

    const deferred = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-31" });
    await clock.advance(20_000);
    const blocked = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-31" });
    await clock.advance(100_000);
    const allowed = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-31" });
    const calls = await call("GET", "/_simulator/calls");

    expect(deferred.statusCode).toBe(202);
    expect(deferred.headers["retry-after"]).toBe("120");
    expect(deferred.json()).toMatchObject({ status: "rate_limited", error: "retry_after_exceeds_cap" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("100");
    expect(allowed.statusCode).toBe(200);
    expect(calls.json().calls[0]).toMatchObject({ status: 429, at: NOW });
    expect(calls.json().calls[1]).toMatchObject({ status: 200, at: "2026-03-31T12:02:00.000Z" });
  });

  it("returns 502 with the run when the provider keeps failing, and 409 after credentials are rejected", async () => {
    const { call } = setup();
    const id = await connect(call);
    await call("POST", "/_simulator/faults", { faults: [{ kind: "unauthorized" }] });

    const failed = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-31" });
    const again = await call("POST", `/connections/${id}/syncs`, { from: "2026-03-01", to: "2026-03-31" });
    const connection = await call("GET", `/connections/${id}`);

    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ status: "failed", error: "unauthorized" });
    expect(again.statusCode).toBe(409);
    expect(connection.json().status).toBe("reauthorization_required");
  });

  it("does not register simulator routes when a real provider is supplied", async () => {
    const context = createContext({ provider: { fetchPostMetrics: async () => ({ items: [], nextCursor: null, rejected: 0 }) } });
    app = buildApp(context);

    const response = await app.inject({ method: "GET", url: "/_simulator/calls" });

    expect(response.statusCode).toBe(404);
  });
});
