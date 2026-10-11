import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { isIsoDay } from "../domain/dates.js";
import { buildMetricsReport } from "../domain/metrics-report.js";
import {
  ConnectionNotActiveError,
  ConnectionNotFoundError,
  ConnectionRateLimitedError,
  InvalidWindowError,
  SyncInProgressError,
} from "../domain/sync-service.js";
import { PLATFORMS, type Connection, type SyncRun } from "../domain/types.js";
import { registerSimulatorRoutes } from "./simulator-routes.js";
import { RequestValidationError, parse } from "./validation.js";

const createConnectionBody = z.object({
  platform: z.enum(PLATFORMS),
  accountId: z.string().trim().min(1).max(128),
  accessToken: z.string().min(8).max(4096),
});

const day = z.string().refine(isIsoDay, "must be a valid YYYY-MM-DD date");
const windowSchema = z.object({ from: day, to: day }).refine((w) => w.from <= w.to, "from must be on or before to");
const idParams = z.object({ id: z.string().min(1) });

const publicConnection = ({ accessToken, ...connection }: Connection) => ({
  ...connection,
  tokenHint: `…${accessToken.slice(-4)}`,
});

const retryAfterSeconds = (retryAt: string, now: Date) =>
  String(Math.max(Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000), 0));

const statusForRun = (run: SyncRun): number => {
  if (run.status === "succeeded") return 200;
  if (run.status === "rate_limited") return 202;
  return 502;
};

function sendError(reply: FastifyReply, status: number, code: string, message: string, extra: object = {}) {
  return reply.status(status).send({ error: { code, message, ...extra } });
}

export function buildApp(context: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestValidationError) {
      return sendError(reply, 400, "invalid_request", error.message, {
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (error instanceof InvalidWindowError) return sendError(reply, 400, "invalid_window", error.message);
    if (error instanceof ConnectionNotFoundError) return sendError(reply, 404, "connection_not_found", error.message);
    if (error instanceof ConnectionNotActiveError) return sendError(reply, 409, "reauthorization_required", error.message);
    if (error instanceof SyncInProgressError) return sendError(reply, 409, "sync_in_progress", error.message);
    if (error instanceof ConnectionRateLimitedError) {
      reply.header("retry-after", retryAfterSeconds(error.retryAt.toISOString(), error.now));
      return sendError(reply, 429, "rate_limited", error.message, { retryAt: error.retryAt.toISOString() });
    }
    const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
    return sendError(reply, status, status === 500 ? "internal_error" : "bad_request", status === 500 ? "internal error" : error.message);
  });

  const requireConnection = (id: string): Connection => {
    const connection = context.connections.get(id);
    if (!connection) throw new ConnectionNotFoundError(id);
    return connection;
  };

  app.get("/health", async () => ({ status: "ok", now: context.clock.now().toISOString() }));

  app.post("/connections", async (request, reply) => {
    const body = parse(createConnectionBody, request.body);
    const connection = context.connections.save({
      id: randomUUID(),
      platform: body.platform,
      accountId: body.accountId,
      accessToken: body.accessToken,
      status: "active",
      createdAt: context.clock.now().toISOString(),
      rateLimitedUntil: null,
      lastSyncedAt: null,
    });
    return reply.status(201).send(publicConnection(connection));
  });

  app.get("/connections/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    return publicConnection(requireConnection(id));
  });

  app.post("/connections/:id/syncs", async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const window = parse(windowSchema, request.body);
    const run = await context.sync.sync(id, window);
    if (run.status === "rate_limited" && run.retryAt) {
      reply.header("retry-after", retryAfterSeconds(run.retryAt, context.clock.now()));
    }
    return reply.status(statusForRun(run)).send(run);
  });

  app.get("/connections/:id/syncs", async (request) => {
    const { id } = parse(idParams, request.params);
    requireConnection(id);
    return { runs: context.runs.listByConnection(id) };
  });

  app.get("/connections/:id/metrics", async (request) => {
    const { id } = parse(idParams, request.params);
    const window = parse(windowSchema, request.query);
    requireConnection(id);
    return buildMetricsReport(id, window, context.metrics.list(id, window));
  });

  if (context.simulator) registerSimulatorRoutes(app, context.simulator);

  return app;
}
