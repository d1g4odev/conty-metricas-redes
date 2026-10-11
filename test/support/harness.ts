import { createContext } from "../../src/context.js";
import type { SyncPolicy } from "../../src/domain/sync-service.js";
import type { Connection } from "../../src/domain/types.js";
import type { SimulatedPost } from "../../src/provider/simulated-platform-api.js";
import { FakeClock } from "./fake-clock.js";

export const NOW = "2026-03-31T12:00:00.000Z";
export const TOKEN = "fake-token-creator-01";
export const ACCOUNT = "acct_creator_01";

export const DEFAULT_POSTS: SimulatedPost[] = [
  { postId: "post_a", publishedOn: "2026-03-01" },
  { postId: "post_b", publishedOn: "2026-03-10" },
  { postId: "post_c", publishedOn: "2026-03-20" },
];

export interface HarnessOptions {
  policy?: Partial<SyncPolicy>;
  pageSize?: number;
  posts?: SimulatedPost[];
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock(NOW);
  const context = createContext({
    clock,
    policy: { requestTimeoutMs: 5_000, ...options.policy },
    pageSize: options.pageSize ?? 10,
  });
  const simulator = context.simulator;
  if (!simulator) throw new Error("simulator expected");
  simulator.addAccount({ platform: "instagram", accountId: ACCOUNT, token: TOKEN, posts: options.posts ?? DEFAULT_POSTS });
  const connection: Connection = context.connections.save({
    id: "conn_1",
    platform: "instagram",
    accountId: ACCOUNT,
    accessToken: TOKEN,
    status: "active",
    createdAt: NOW,
    rateLimitedUntil: null,
    lastSyncedAt: null,
  });
  const sync = (from: string, to: string) => clock.run(context.sync.sync(connection.id, { from, to }));
  const report = (from: string, to: string) => context.metrics.list(connection.id, { from, to });
  return { clock, context, simulator, connection, sync, report };
}
