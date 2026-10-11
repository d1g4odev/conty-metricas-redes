import { z } from "zod";
import {
  ProviderAuthError,
  ProviderInvalidResponseError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type MetricsProvider,
  type PostMetricsRequest,
  type ProviderMetricRow,
  type ProviderPage,
} from "../domain/provider-port.js";

export interface TransportRequest {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface PlatformTransport {
  get(request: TransportRequest): Promise<TransportResponse>;
}

const count = z.number().int().nonnegative();

const wireRow = z.object({
  post_id: z.string().min(1),
  date: z.string(),
  views: count,
  likes: count,
  comments: count,
  shares: count,
  updated_time: z.string(),
});

const wirePage = z.object({
  data: z.array(z.unknown()),
  paging: z.object({ next_cursor: z.string().min(1).nullable() }),
});

export const postInsightsPath = (platform: string, accountId: string) =>
  `/v1/${platform}/accounts/${encodeURIComponent(accountId)}/post-insights`;

export class PlatformMetricsProvider implements MetricsProvider {
  constructor(private readonly transport: PlatformTransport) {}

  async fetchPostMetrics(request: PostMetricsRequest): Promise<ProviderPage> {
    const query: Record<string, string> = { since: request.from, until: request.to };
    if (request.cursor !== null) query.after = request.cursor;
    const response = await this.transport.get({
      path: postInsightsPath(request.platform, request.accountId),
      query,
      headers: { authorization: `Bearer ${request.accessToken}` },
      signal: request.signal,
    });
    return this.toPage(response);
  }

  private toPage(response: TransportResponse): ProviderPage {
    const { status } = response;
    if (status === 429) throw new ProviderRateLimitedError(response.headers["retry-after"] ?? null);
    if (status === 401 || status === 403) throw new ProviderAuthError(status);
    if (status === 408 || status >= 500) throw new ProviderUnavailableError(status);
    if (status !== 200) throw new ProviderRejectedError(status);

    const parsed = wirePage.safeParse(response.body);
    if (!parsed.success) throw new ProviderInvalidResponseError(parsed.error.issues[0]?.message ?? "unknown shape");

    const items: ProviderMetricRow[] = [];
    let rejected = 0;
    for (const raw of parsed.data.data) {
      const row = wireRow.safeParse(raw);
      if (!row.success) {
        rejected += 1;
        continue;
      }
      items.push({
        postId: row.data.post_id,
        date: row.data.date,
        views: row.data.views,
        likes: row.data.likes,
        comments: row.data.comments,
        shares: row.data.shares,
        updatedAt: row.data.updated_time,
      });
    }
    return { items, nextCursor: parsed.data.paging.next_cursor, rejected };
  }
}
