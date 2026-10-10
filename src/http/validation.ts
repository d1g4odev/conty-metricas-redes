import type { z } from "zod";

export class RequestValidationError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super("invalid request");
    this.name = "RequestValidationError";
  }
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error.issues);
  return result.data;
}
