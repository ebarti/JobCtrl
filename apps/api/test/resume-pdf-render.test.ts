import { describe, expect, it } from "vitest";

import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";
import { createResumeHtmlPdfRenderer, ResumeRenderError } from "../src/resume-pdf-render.js";

describe("resume pdf renderer", () => {
  it("dispatches render_resume_pdf and resolves on a valid result", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const dispatcher: JsonRpcDispatcher = {
      call: async (method, params) => {
        calls.push({ method, params });
        return {
          jsonrpc: "2.0" as const,
          id: 1,
          result: { status: "succeeded", pdfPath: String(params.pdfPath) },
        };
      },
      close: async () => {},
    };
    await createResumeHtmlPdfRenderer(dispatcher)({ htmlPath: "/tmp/in.html", pdfPath: "/tmp/out.pdf" });
    expect(calls).toEqual([
      { method: "render_resume_pdf", params: { htmlPath: "/tmp/in.html", pdfPath: "/tmp/out.pdf" } },
    ]);
  });

  it("wraps dispatcher rejections in ResumeRenderError", async () => {
    const dispatcher: JsonRpcDispatcher = {
      call: async () => {
        throw new Error("JSON-RPC request timed out after 600000ms");
      },
      close: async () => {},
    };
    const render = createResumeHtmlPdfRenderer(dispatcher);
    await expect(render({ htmlPath: "/tmp/in.html", pdfPath: "/tmp/out.pdf" })).rejects.toThrow(
      ResumeRenderError,
    );
    await expect(render({ htmlPath: "/tmp/in.html", pdfPath: "/tmp/out.pdf" })).rejects.toThrow(
      "Resume HTML-to-PDF render failed: JSON-RPC request timed out after 600000ms",
    );
  });

  it("wraps error envelopes preferring error.data and rejects invalid results", async () => {
    const errorDispatcher: JsonRpcDispatcher = {
      call: async () => ({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -32603, message: "Internal error", data: "[Errno 21] Is a directory" },
      }),
      close: async () => {},
    };
    await expect(
      createResumeHtmlPdfRenderer(errorDispatcher)({ htmlPath: "a", pdfPath: "b" }),
    ).rejects.toThrow("Resume HTML-to-PDF render failed: [Errno 21] Is a directory");

    const invalidDispatcher: JsonRpcDispatcher = {
      call: async () => ({ jsonrpc: "2.0" as const, id: 1, result: { nope: true } }),
      close: async () => {},
    };
    await expect(
      createResumeHtmlPdfRenderer(invalidDispatcher)({ htmlPath: "a", pdfPath: "b" }),
    ).rejects.toThrow(ResumeRenderError);
  });
});
