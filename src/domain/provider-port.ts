import type { Platform } from "./types.js";

export interface PostMetricsRequest {
  platform: Platform;
  accountId: string;
  accessToken: string;
  from: string;
  to: string;
  cursor: string | null;
  signal: AbortSignal;
}

export interface ProviderMetricRow {
  postId: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  updatedAt: string;
}

export interface ProviderPage {
  items: ProviderMetricRow[];
  nextCursor: string | null;
  rejected: number;
}

export interface MetricsProvider {
  fetchPostMetrics(request: PostMetricsRequest): Promise<ProviderPage>;
}

export class ProviderRateLimitedError extends Error {
  constructor(readonly retryAfter: string | null) {
    super("provider rate limited the request");
    this.name = "ProviderRateLimitedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`provider unavailable (status ${status})`);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderInvalidResponseError extends Error {
  constructor(detail: string) {
    super(`provider returned an invalid response: ${detail}`);
    this.name = "ProviderInvalidResponseError";
  }
}

export class ProviderAuthError extends Error {
  constructor(readonly status: number) {
    super(`provider rejected the credentials (status ${status})`);
    this.name = "ProviderAuthError";
  }
}

export class ProviderRejectedError extends Error {
  constructor(readonly status: number) {
    super(`provider rejected the request (status ${status})`);
    this.name = "ProviderRejectedError";
  }
}
