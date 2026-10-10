import {
  ProviderAuthError,
  ProviderInvalidResponseError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "./provider-port.js";
import { RequestTimeoutError } from "./timeout.js";

export class ReplayedPageError extends Error {
  constructor(readonly cursor: string | null) {
    super("provider answered with a page that was already processed");
    this.name = "ReplayedPageError";
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  requestTimeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxRetryAfterMs: number;
  maxTotalWaitMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  requestTimeoutMs: 10_000,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 60_000,
  maxTotalWaitMs: 120_000,
};

export type RetryDecision =
  | { action: "retry"; delayMs: number; reason: string }
  | { action: "stop"; status: "failed" | "rate_limited"; reason: string; retryAt: Date | null };

export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/[a-z]/i.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(at - now.getTime(), 0);
}

export const backoffDelay = (attempt: number, policy: RetryPolicy): number =>
  Math.min(policy.baseBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);

function transientReason(error: unknown): string | null {
  if (error instanceof RequestTimeoutError) return "timeout";
  if (error instanceof ProviderUnavailableError) return "provider_unavailable";
  if (error instanceof ProviderInvalidResponseError) return "invalid_response";
  if (error instanceof ReplayedPageError) return "replayed_page";
  return null;
}

export function decideRetry(
  error: unknown,
  attempt: number,
  waitedMs: number,
  now: Date,
  policy: RetryPolicy,
): RetryDecision {
  if (error instanceof ProviderAuthError) {
    return { action: "stop", status: "failed", reason: "unauthorized", retryAt: null };
  }
  if (error instanceof ProviderRejectedError) {
    return { action: "stop", status: "failed", reason: "provider_rejected", retryAt: null };
  }
  if (error instanceof ProviderRateLimitedError) {
    const delayMs = parseRetryAfter(error.retryAfter, now) ?? backoffDelay(attempt, policy);
    const retryAt = new Date(now.getTime() + delayMs);
    if (attempt >= policy.maxAttempts) {
      return { action: "stop", status: "rate_limited", reason: "rate_limit_attempts_exhausted", retryAt };
    }
    if (delayMs > policy.maxRetryAfterMs) {
      return { action: "stop", status: "rate_limited", reason: "retry_after_exceeds_cap", retryAt };
    }
    if (waitedMs + delayMs > policy.maxTotalWaitMs) {
      return { action: "stop", status: "rate_limited", reason: "wait_budget_exhausted", retryAt };
    }
    return { action: "retry", delayMs, reason: "rate_limited" };
  }
  const reason = transientReason(error);
  if (reason === null) {
    return { action: "stop", status: "failed", reason: "unexpected_error", retryAt: null };
  }
  if (attempt >= policy.maxAttempts) {
    return { action: "stop", status: "failed", reason: `${reason}_attempts_exhausted`, retryAt: null };
  }
  const delayMs = backoffDelay(attempt, policy);
  if (waitedMs + delayMs > policy.maxTotalWaitMs) {
    return { action: "stop", status: "failed", reason: "wait_budget_exhausted", retryAt: null };
  }
  return { action: "retry", delayMs, reason };
}
