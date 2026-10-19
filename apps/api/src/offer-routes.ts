import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SaveOfferTermsSchema,
  RecordOfferDecisionSchema,
} from "@jobctrl/contracts";
import { openDatabase } from "./db.js";
import {
  readOffer,
  saveOfferTerms,
  recordOfferDecision,
  OfferConflictError,
  OfferNotFoundError,
} from "./offers.js";

export function registerOfferRoutes(
  app: FastifyInstance,
  dbPath: string,
): void {
  for (const action of ["read", "terms", "decisions"] as const) {
    app.route<{ Params: { jobId: string } }>({
      method: action === "read" ? "GET" : "POST",
      url: `/v1/jobs/:jobId/offer${action === "read" ? "" : "/" + action}`,
      handler: async (request, reply) => {
        const jobId = z.uuid().safeParse(request.params.jobId);
        if (!jobId.success)
          return reply.code(400).send({ ok: false, error: "invalid_job_id" });
        const terms =
          action === "terms"
            ? SaveOfferTermsSchema.safeParse(request.body)
            : null;
        const decision =
          action === "decisions"
            ? RecordOfferDecisionSchema.safeParse(request.body)
            : null;
        if (terms?.success === false || decision?.success === false) {
          return reply
            .code(400)
            .send({
              ok: false,
              error: "invalid_offer",
              message: "Review the offer fields and confirm each source.",
            });
        }
        const db = openDatabase(dbPath);
        try {
          if (terms?.success) return saveOfferTerms(db, jobId.data, terms.data);
          if (decision?.success)
            return recordOfferDecision(db, jobId.data, decision.data);
          return readOffer(db, jobId.data);
        } catch (error) {
          if (
            error instanceof OfferConflictError ||
            error instanceof OfferNotFoundError
          ) {
            return reply
              .code(error instanceof OfferConflictError ? 409 : 404)
              .send({
                ok: false,
                error:
                  error instanceof OfferConflictError
                    ? "offer_conflict"
                    : "not_found",
                message: error.message,
              });
          }
          throw error;
        } finally {
          db.close();
        }
      },
    });
  }
}
