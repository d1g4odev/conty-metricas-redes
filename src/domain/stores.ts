import { isWithin, type DateWindow } from "./dates.js";
import type { Connection, StoredMetric, SyncRun } from "./types.js";

export type UpsertOutcome = "inserted" | "updated" | "unchanged" | "stale";

export type MetricObservation = Omit<StoredMetric, "firstFetchedAt">;

const metricKey = (connectionId: string, postId: string, date: string) =>
  JSON.stringify([connectionId, postId, date]);

const sameValues = (a: MetricObservation, b: StoredMetric) =>
  a.views === b.views && a.likes === b.likes && a.comments === b.comments && a.shares === b.shares;

export class MetricsStore {
  private readonly rows = new Map<string, StoredMetric>();

  upsert(observation: MetricObservation): UpsertOutcome {
    const key = metricKey(observation.connectionId, observation.postId, observation.date);
    const current = this.rows.get(key);
    if (!current) {
      this.rows.set(key, { ...observation, firstFetchedAt: observation.fetchedAt });
      return "inserted";
    }
    const incomingVersion = Date.parse(observation.providerUpdatedAt);
    const currentVersion = Date.parse(current.providerUpdatedAt);
    if (incomingVersion < currentVersion) return "stale";
    const outcome = incomingVersion === currentVersion && sameValues(observation, current) ? "unchanged" : "updated";
    this.rows.set(key, { ...observation, firstFetchedAt: current.firstFetchedAt });
    return outcome;
  }

  list(connectionId: string, window: DateWindow): StoredMetric[] {
    return [...this.rows.values()]
      .filter((row) => row.connectionId === connectionId && isWithin(row.date, window))
      .sort((a, b) => a.postId.localeCompare(b.postId) || a.date.localeCompare(b.date));
  }

  count(): number {
    return this.rows.size;
  }
}

export class ConnectionStore {
  private readonly connections = new Map<string, Connection>();

  save(connection: Connection): Connection {
    this.connections.set(connection.id, connection);
    return connection;
  }

  get(id: string): Connection | undefined {
    return this.connections.get(id);
  }
}

export class SyncRunStore {
  private readonly runs = new Map<string, SyncRun>();

  save(run: SyncRun): SyncRun {
    this.runs.set(run.id, run);
    return run;
  }

  listByConnection(connectionId: string): SyncRun[] {
    return [...this.runs.values()]
      .filter((run) => run.connectionId === connectionId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
