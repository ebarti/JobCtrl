import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";
import { getDefaultJsonRpcDispatcher } from "./json-rpc-adapter.js";
import { RenderResumePdfResultSchema, RpcMethods } from "./contracts.js";

export interface ResumeHtmlPdfRenderInput {
  readonly htmlPath: string;
  readonly pdfPath: string;
}

export type ResumeHtmlPdfRenderer = (input: ResumeHtmlPdfRenderInput) => Promise<void>;

// Renders pre-built resume HTML to a full, paginated PDF via the same
// Playwright adapter the Python worker uses — through the long-lived JSON-RPC
// worker child rather than a synchronous subprocess, so the API's event loop
// keeps serving during Chromium renders. Callers persist database rows only
// after the awaited render returns, never around it.
export class ResumeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRenderError";
  }
}

export function createResumeHtmlPdfRenderer(dispatcher: JsonRpcDispatcher): ResumeHtmlPdfRenderer {
  return async ({ htmlPath, pdfPath }) => {
    const response = await dispatcher.call(RpcMethods.RenderResumePdf, { htmlPath, pdfPath });
    if (response.error) {
      // The RPC server wraps handler exceptions as a generic "Internal
      // error" message and puts the real cause in error.data.
      const detail =
        typeof response.error.data === "string" && response.error.data.trim()
          ? response.error.data
          : response.error.message;
      throw new ResumeRenderError(`Resume HTML-to-PDF render failed: ${detail}`);
    }
    const parsed = RenderResumePdfResultSchema.safeParse(response.result);
    if (!parsed.success) {
      throw new ResumeRenderError("Resume HTML-to-PDF render returned an invalid result.");
    }
  };
}

export const defaultResumeHtmlPdfRenderer: ResumeHtmlPdfRenderer = (input) =>
  createResumeHtmlPdfRenderer(getDefaultJsonRpcDispatcher())(input);
