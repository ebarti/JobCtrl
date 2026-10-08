/** Accepted download response: contained bytes are read and hash-checked by the worker. */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  LocaleExportRequestSchema,
  LocaleExportSchema,
  RpcMethods,
} from "./contracts.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

export function registerLocaleDownloads(
  app: FastifyInstance,
  dispatcher: JsonRpcDispatcher,
  context: { appDir: string; dbPath: string },
): void {
  app.get<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/locale-variants/download",
    async (request, reply) => {
      const query = LocaleExportRequestSchema.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ ok: false, error: "invalid_locale_export" });
      try {
        const response = await dispatcher.call(RpcMethods.LocaleVariants, {
          ...query.data,
          operation: "export",
          tenantId: "local",
          jobId: request.params.jobKey,
          expectedAppDir: context.appDir,
          expectedDbPath: context.dbPath,
        });
        if (response.error)
          return reply
            .code(409)
            .send({
              ok: false,
              error: "locale_export_failed",
              message: response.error.message,
            });
        const parsed = LocaleExportSchema.safeParse(response.result);
        if (!parsed.success)
          return reply
            .code(502)
            .send({ ok: false, error: "invalid_locale_export" });
        const bytes = Buffer.from(parsed.data.data, "base64");
        if (
          parsed.data.format !== query.data.format ||
          createHash("sha256").update(bytes).digest("hex") !== parsed.data.hash
        )
          return reply
            .code(502)
            .send({ ok: false, error: "invalid_locale_export" });
        const formats = {
          text: ["text/plain; charset=utf-8", "txt"],
          html: ["text/html; charset=utf-8", "html"],
          pdf: ["application/pdf", "pdf"],
          docx: [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
          ],
        } as const;
        const [mime, extension] = formats[query.data.format];
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="locale-variant.${extension}"`,
          )
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "no-store")
          .header("Content-Security-Policy", "sandbox; default-src 'none'")
          .type(mime)
          .send(bytes);
      } catch {
        return reply
          .code(503)
          .send({ ok: false, error: "locale_worker_unavailable" });
      }
    },
  );
}
