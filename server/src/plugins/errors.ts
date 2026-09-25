import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError, InsufficientCopiesError } from "../domain/errors.js";

/** Maps domain errors to proper HTTP statuses (so the UI can show friendly messages). */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ValidationError || error instanceof InsufficientCopiesError) {
      return reply.code(400).send({ error: "validation", message: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: "not_found", message: error.message });
    }
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode) || 500
        : 500;
    if (status >= 500) {
      app.log.error(error);
    }
    const message = error instanceof Error ? error.message : "unexpected error";
    return reply.code(status).send({ error: "internal", message });
  });
}