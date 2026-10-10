import { describe, expect, it } from "vitest";
import { ProviderAuthError, ProviderRateLimitedError, ProviderUnavailableError } from "../src/domain/provider-port.js";
import { DEFAULT_RETRY_POLICY, backoffDelay, decideRetry, parseRetryAfter } from "../src/domain/retry.js";
import { RequestTimeoutError } from "../src/domain/timeout.js";

const now = new Date("2026-03-31T12:00:00.000Z");
const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 4, maxRetryAfterMs: 60_000, maxTotalWaitMs: 90_000 };

describe("parseRetryAfter", () => {
  it.each([
    ["30", 30_000],
    [" 0 ", 0],
    ["Tue, 31 Mar 2026 12:01:00 GMT", 60_000],
    ["Tue, 31 Mar 2026 11:00:00 GMT", 0],
    ["-1", null],
    ["1.5", null],
    ["soon", null],
    ["", null],
    [null, null],
  ])("parses %j", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe("decideRetry", () => {
  it("respects Retry-After within the cap", () => {
    expect(decideRetry(new ProviderRateLimitedError("45"), 1, 0, now, policy)).toEqual({
      action: "retry",
      delayMs: 45_000,
      reason: "rate_limited",
    });
  });

  it("defers instead of waiting beyond the cap", () => {
    expect(decideRetry(new ProviderRateLimitedError("61"), 1, 0, now, policy)).toEqual({
      action: "stop",
      status: "rate_limited",
      reason: "retry_after_exceeds_cap",
      retryAt: new Date("2026-03-31T12:01:01.000Z"),
    });
  });

  it("stops on the last attempt even when the wait would be allowed", () => {
    expect(decideRetry(new ProviderRateLimitedError("1"), 4, 0, now, policy)).toMatchObject({
      action: "stop",
      reason: "rate_limit_attempts_exhausted",
    });
  });

  it("respects the total wait budget", () => {
    expect(decideRetry(new ProviderRateLimitedError("30"), 2, 70_000, now, policy)).toMatchObject({
      action: "stop",
      reason: "wait_budget_exhausted",
    });
  });

  it("backs off on timeouts and 5xx and never retries credentials errors", () => {
    expect(decideRetry(new RequestTimeoutError(5_000), 2, 0, now, policy)).toMatchObject({ action: "retry", delayMs: 1_000 });
    expect(decideRetry(new ProviderUnavailableError(503), 4, 0, now, policy)).toMatchObject({
      action: "stop",
      reason: "provider_unavailable_attempts_exhausted",
    });
    expect(decideRetry(new ProviderAuthError(401), 1, 0, now, policy)).toMatchObject({ action: "stop", reason: "unauthorized" });
    expect(decideRetry(new TypeError("boom"), 1, 0, now, policy)).toMatchObject({ action: "stop", reason: "unexpected_error" });
  });

  it("caps exponential backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt, policy))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });
});
