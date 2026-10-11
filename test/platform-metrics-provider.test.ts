import { describe, expect, it } from "vitest";
import {
  ProviderAuthError,
  ProviderInvalidResponseError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type PostMetricsRequest,
} from "../src/domain/provider-port.js";
import { PlatformMetricsProvider, type TransportRequest, type TransportResponse } from "../src/provider/platform-metrics-provider.js";

const request: PostMetricsRequest = {
  platform: "tiktok",
  accountId: "acct 1",
  accessToken: "fake-token-xyz",
  from: "2026-03-01",
  to: "2026-03-02",
  cursor: "abc",
  signal: new AbortController().signal,
};

const providerReturning = (response: TransportResponse) => {
  const seen: TransportRequest[] = [];
  const provider = new PlatformMetricsProvider({
    get: async (req) => {
      seen.push(req);
      return response;
    },
  });
  return { provider, seen };
};

describe("PlatformMetricsProvider", () => {
  it("maps the wire format into provider rows and sends the token as a bearer header", async () => {
    const { provider, seen } = providerReturning({
      status: 200,
      headers: {},
      body: {
        data: [
          { post_id: "p1", date: "2026-03-01", views: 10, likes: 2, comments: 1, shares: 0, updated_time: "2026-03-01T00:00:00Z" },
          { post_id: "p2", date: "2026-03-01", views: -1, likes: 0, comments: 0, shares: 0, updated_time: "x" },
        ],
        paging: { next_cursor: null },
      },
    });

    const page = await provider.fetchPostMetrics(request);

    expect(seen[0]).toMatchObject({
      path: "/v1/tiktok/accounts/acct%201/post-insights",
      query: { since: "2026-03-01", until: "2026-03-02", after: "abc" },
      headers: { authorization: "Bearer fake-token-xyz" },
    });
    expect(page).toEqual({
      items: [{ postId: "p1", date: "2026-03-01", views: 10, likes: 2, comments: 1, shares: 0, updatedAt: "2026-03-01T00:00:00Z" }],
      nextCursor: null,
      rejected: 1,
    });
  });

  it.each([
    [{ status: 429, headers: { "retry-after": "7" }, body: {} }, ProviderRateLimitedError],
    [{ status: 401, headers: {}, body: {} }, ProviderAuthError],
    [{ status: 403, headers: {}, body: {} }, ProviderAuthError],
    [{ status: 503, headers: {}, body: {} }, ProviderUnavailableError],
    [{ status: 408, headers: {}, body: {} }, ProviderUnavailableError],
    [{ status: 404, headers: {}, body: {} }, ProviderRejectedError],
    [{ status: 200, headers: {}, body: { items: [] } }, ProviderInvalidResponseError],
  ])("maps status %j to a domain error", async (response, errorType) => {
    const { provider } = providerReturning(response);

    await expect(provider.fetchPostMetrics(request)).rejects.toBeInstanceOf(errorType);
  });

  it("forwards the raw Retry-After header", async () => {
    const { provider } = providerReturning({ status: 429, headers: { "retry-after": "7" }, body: {} });

    await expect(provider.fetchPostMetrics(request)).rejects.toMatchObject({ retryAfter: "7" });
  });
});
