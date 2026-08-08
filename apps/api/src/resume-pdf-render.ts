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
export function createResumeHtmlPdfRenderer(dispatcher: JsonRpcDispatcher): ResumeHtmlPdfRenderer {
  return async ({ htmlPath, pdfPath }) => {
    const response = await dispatcher.call(RpcMethods.RenderResumePdf, { htmlPath, pdfPath });
    if (response.error) {
      throw new Error(`Resume HTML-to-PDF render failed: ${response.error.message}`);
    }
    const parsed = RenderResumePdfResultSchema.safeParse(response.result);
    if (!parsed.success) {
      throw new Error("Resume HTML-to-PDF render returned an invalid result.");
    }
  };
}

export const defaultResumeHtmlPdfRenderer: ResumeHtmlPdfRenderer = (input) =>
  createResumeHtmlPdfRenderer(getDefaultJsonRpcDispatcher())(input);
