import { systemClock, type Clock } from "./domain/clock.js";
import type { MetricsProvider } from "./domain/provider-port.js";
import { ConnectionStore, MetricsStore, SyncRunStore } from "./domain/stores.js";
import { SyncService, type SyncPolicy } from "./domain/sync-service.js";
import { PlatformMetricsProvider } from "./provider/platform-metrics-provider.js";
import { SimulatedPlatformApi } from "./provider/simulated-platform-api.js";

export interface AppContext {
  clock: Clock;
  connections: ConnectionStore;
  metrics: MetricsStore;
  runs: SyncRunStore;
  sync: SyncService;
  simulator: SimulatedPlatformApi | null;
}

export interface ContextOptions {
  clock?: Clock;
  policy?: Partial<SyncPolicy>;
  provider?: MetricsProvider;
  pageSize?: number;
}

function resolveProvider(options: ContextOptions, clock: Clock) {
  if (options.provider) return { provider: options.provider, simulator: null };
  const simulator = new SimulatedPlatformApi(clock, options.pageSize);
  return { provider: new PlatformMetricsProvider(simulator), simulator };
}

export function createContext(options: ContextOptions = {}): AppContext {
  const clock = options.clock ?? systemClock;
  const { provider, simulator } = resolveProvider(options, clock);
  const connections = new ConnectionStore();
  const metrics = new MetricsStore();
  const runs = new SyncRunStore();
  const sync = new SyncService({ connections, metrics, runs, provider, clock, policy: options.policy ?? {} });
  return { clock, connections, metrics, runs, sync, simulator };
}
