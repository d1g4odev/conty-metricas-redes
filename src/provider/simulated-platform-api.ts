import type { Clock } from "../domain/clock.js";
import { eachDay, isIsoDay, toIsoDay } from "../domain/dates.js";
import type { MetricValues } from "../domain/types.js";
import type { PlatformTransport, TransportRequest, TransportResponse } from "./platform-metrics-provider.js";

export type SimulatedFault =
  | { kind: "ok" }
  | { kind: "rate_limit"; retryAfter?: string | null }
  | { kind: "timeout" }
  | { kind: "server_error"; status?: number }
  | { kind: "duplicate_page" }
  | { kind: "duplicate_items" }
  | { kind: "malformed_row" }
  | { kind: "unauthorized" };

export interface SimulatedPost {
  postId: string;
  publishedOn: string;
}

export interface SimulatedAccount {
  platform: string;
  accountId: string;
  token: string;
  posts: SimulatedPost[];
}

export interface SimulatedCall {
  at: string;
  accountId: string | null;
  cursor: string | null;
  status: number | "hung";
  fault: SimulatedFault["kind"] | null;
}

interface WireRow {
  post_id: string;
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  updated_time: string;
}

const HANG_MS = 3_600_000;
const PATH = /^\/v1\/([^/]+)\/accounts\/([^/]+)\/post-insights$/;

const hash = (input: string): number => {
  let value = 0x811c9dc5;
  for (const char of input) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
};

const baseline = (accountId: string, postId: string, date: string): MetricValues => {
  const seed = hash(`${accountId}|${postId}|${date}`);
  const views = 100 + (seed % 4_900);
  return {
    views,
    likes: Math.floor(views * (0.05 + (seed % 7) / 100)),
    comments: Math.floor(views * 0.01) + (seed % 5),
    shares: Math.floor(views * 0.005) + (seed % 3),
  };
};

const encodeCursor = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");

const decodeCursor = (cursor: string): number | null => {
  const match = /^offset:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  return match ? Number(match[1]) : null;
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body,
});

export class SimulatedPlatformApi implements PlatformTransport {
  private readonly accounts = new Map<string, SimulatedAccount>();
  private readonly tokens = new Map<string, string>();
  private readonly revisions = new Map<string, MetricValues & { updatedTime: string }>();
  private readonly faults: SimulatedFault[] = [];
  private lastSuccess: TransportResponse | null = null;
  readonly calls: SimulatedCall[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly pageSize = 20,
  ) {}

  addAccount(account: SimulatedAccount): void {
    this.accounts.set(account.accountId, { ...account, posts: [...account.posts] });
    this.tokens.set(account.token, account.accountId);
  }

  revise(accountId: string, postId: string, date: string, values: Partial<MetricValues>): void {
    const key = JSON.stringify([accountId, postId, date]);
    const current = this.revisions.get(key) ?? baseline(accountId, postId, date);
    this.revisions.set(key, { ...current, ...values, updatedTime: this.clock.now().toISOString() });
  }

  injectFaults(...faults: SimulatedFault[]): void {
    this.faults.push(...faults);
  }

  pendingFaults(): number {
    return this.faults.length;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  async get(request: TransportRequest): Promise<TransportResponse> {
    const fault = this.faults.shift() ?? null;
    const match = PATH.exec(request.path);
    const call: SimulatedCall = {
      at: this.clock.now().toISOString(),
      accountId: match?.[2] === undefined ? null : decodeURIComponent(match[2]),
      cursor: request.query.after ?? null,
      status: "hung",
      fault: fault?.kind ?? null,
    };
    this.calls.push(call);
    if (fault?.kind === "timeout") await this.clock.sleep(HANG_MS, request.signal);
    const response = this.respond(request, match?.[1] ?? null, call.accountId, fault);
    call.status = response.status;
    return response;
  }

  private respond(
    request: TransportRequest,
    platform: string | null,
    accountId: string | null,
    fault: SimulatedFault | null,
  ): TransportResponse {
    const account = accountId === null ? undefined : this.accounts.get(accountId);
    if (!account || account.platform !== platform) return json(404, { error: { code: "not_found" } });

    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const owner = this.tokens.get(token);
    if (owner === undefined || fault?.kind === "unauthorized") return json(401, { error: { code: "invalid_token" } });
    if (owner !== account.accountId) return json(403, { error: { code: "forbidden" } });

    if (fault?.kind === "rate_limit") {
      const headers: Record<string, string> = fault.retryAfter === null || fault.retryAfter === undefined ? {} : { "retry-after": fault.retryAfter };
      return json(429, { error: { code: "rate_limited" } }, headers);
    }
    if (fault?.kind === "server_error") return json(fault.status ?? 503, { error: { code: "unavailable" } });
    if (fault?.kind === "duplicate_page" && this.lastSuccess) return structuredClone(this.lastSuccess);

    const since = request.query.since ?? "";
    const until = request.query.until ?? "";
    if (!isIsoDay(since) || !isIsoDay(until) || since > until) return json(400, { error: { code: "invalid_range" } });
    const offset = request.query.after === undefined ? 0 : decodeCursor(request.query.after);
    if (offset === null) return json(400, { error: { code: "invalid_cursor" } });

    const rows = this.rowsFor(account, since, until);
    const slice: unknown[] = rows.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize < rows.length ? encodeCursor(offset + this.pageSize) : null;
    const data = fault?.kind === "duplicate_items" ? slice.flatMap((row) => [row, row]) : slice;
    if (fault?.kind === "malformed_row") data.push({ post_id: 42, date: "yesterday" });

    const response = json(200, { data, paging: { next_cursor: next } });
    this.lastSuccess = structuredClone(response);
    return response;
  }

  private rowsFor(account: SimulatedAccount, since: string, until: string): WireRow[] {
    const today = toIsoDay(this.clock.now());
    const last = until < today ? until : today;
    if (since > last) return [];
    const rows: WireRow[] = [];
    for (const date of eachDay({ from: since, to: last })) {
      for (const post of account.posts) {
        if (post.publishedOn > date) continue;
        const revision = this.revisions.get(JSON.stringify([account.accountId, post.postId, date]));
        const values = revision ?? baseline(account.accountId, post.postId, date);
        rows.push({
          post_id: post.postId,
          date,
          views: values.views,
          likes: values.likes,
          comments: values.comments,
          shares: values.shares,
          updated_time: revision?.updatedTime ?? `${date}T00:00:00.000Z`,
        });
      }
    }
    return rows;
  }
}
