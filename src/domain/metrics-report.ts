import type { DateWindow } from "./dates.js";
import type { MetricValues, StoredMetric } from "./types.js";

export interface PostMetricsReport {
  postId: string;
  totals: MetricValues;
  lastFetchedAt: string;
  days: {
    date: string;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    fetchedAt: string;
    firstFetchedAt: string;
    providerUpdatedAt: string;
  }[];
}

export interface MetricsReport {
  connectionId: string;
  window: DateWindow;
  totals: MetricValues;
  lastFetchedAt: string | null;
  posts: PostMetricsReport[];
}

const zero = (): MetricValues => ({ views: 0, likes: 0, comments: 0, shares: 0 });

const add = (target: MetricValues, row: MetricValues): void => {
  target.views += row.views;
  target.likes += row.likes;
  target.comments += row.comments;
  target.shares += row.shares;
};

const latest = (a: string | null, b: string): string => (a === null || b > a ? b : a);

export function buildMetricsReport(connectionId: string, window: DateWindow, rows: StoredMetric[]): MetricsReport {
  const posts = new Map<string, PostMetricsReport>();
  const totals = zero();
  let lastFetchedAt: string | null = null;
  for (const row of rows) {
    const post = posts.get(row.postId) ?? { postId: row.postId, totals: zero(), lastFetchedAt: row.fetchedAt, days: [] };
    add(post.totals, row);
    add(totals, row);
    post.lastFetchedAt = latest(post.lastFetchedAt, row.fetchedAt);
    lastFetchedAt = latest(lastFetchedAt, row.fetchedAt);
    post.days.push({
      date: row.date,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      fetchedAt: row.fetchedAt,
      firstFetchedAt: row.firstFetchedAt,
      providerUpdatedAt: row.providerUpdatedAt,
    });
    posts.set(row.postId, post);
  }
  return { connectionId, window, totals, lastFetchedAt, posts: [...posts.values()] };
}
