import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isIsoDay } from "../domain/dates.js";
import type { SimulatedPlatformApi } from "../provider/simulated-platform-api.js";
import { parse } from "./validation.js";

const count = z.number().int().nonnegative();

const fault = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  z.object({ kind: z.literal("rate_limit"), retryAfter: z.string().nullable().optional() }),
  z.object({ kind: z.literal("timeout") }),
  z.object({ kind: z.literal("server_error"), status: z.number().int().min(500).max(599).optional() }),
  z.object({ kind: z.literal("duplicate_page") }),
  z.object({ kind: z.literal("duplicate_items") }),
  z.object({ kind: z.literal("malformed_row") }),
  z.object({ kind: z.literal("unauthorized") }),
]);

const faultsBody = z.object({ faults: z.array(fault).min(1).max(50) });

const revisionBody = z.object({
  accountId: z.string().min(1),
  postId: z.string().min(1),
  date: z.string().refine(isIsoDay),
  views: count.optional(),
  likes: count.optional(),
  comments: count.optional(),
  shares: count.optional(),
});

export function registerSimulatorRoutes(app: FastifyInstance, simulator: SimulatedPlatformApi): void {
  app.post("/_simulator/faults", async (request, reply) => {
    const { faults } = parse(faultsBody, request.body);
    simulator.injectFaults(...faults);
    return reply.status(202).send({ pending: simulator.pendingFaults() });
  });

  app.post("/_simulator/revisions", async (request, reply) => {
    const { accountId, postId, date, ...values } = parse(revisionBody, request.body);
    simulator.revise(accountId, postId, date, Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)));
    return reply.status(204).send();
  });

  app.get("/_simulator/calls", async () => ({ calls: simulator.calls }));
}
