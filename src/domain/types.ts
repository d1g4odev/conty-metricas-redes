import type { DateWindow } from "./dates.js";

export const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface MetricValues {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export type ConnectionStatus = "active" | "reauthorization_required";

export interface Connection {
  id: string;
  platform: Platform;
  accountId: string;
  accessToken: string;
  status: ConnectionStatus;
  createdAt: string;
  rateLimitedUntil: string | null;
  lastSyncedAt: string | null;
}

export interface StoredMetric extends MetricValues {
  connectionId: string;
  postId: string;
  date: string;
  providerUpdatedAt: string;
  firstFetchedAt: string;
  fetchedAt: string;
  syncRunId: string;
}

export type SyncStatus = "running" | "succeeded" | "failed" | "rate_limited";

export interface SyncStats {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  duplicates: number;
  rejected: number;
  replayedPages: number;
}

export interface SyncRun {
  id: string;
  connectionId: string;
  window: DateWindow;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  providerCalls: number;
  pages: number;
  waitedMs: number;
  waits: { reason: string; ms: number }[];
  stats: SyncStats;
  retryAt: string | null;
  error: string | null;
}
