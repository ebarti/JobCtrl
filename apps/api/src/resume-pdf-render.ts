import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_PROJECT_DIR = path.resolve(API_SRC_DIR, "../../../workers/automation");

// The render is synchronous so it can run inside the better-sqlite3 write
// transaction. Bound the subprocess so a hung `uv` resolve or Chromium launch
// cannot freeze the Node event loop indefinitely; on timeout execFileSync throws
// and the caller's catch turns it into a preserved-generation render failure.
// Generous enough for a cold Chromium start.
const RESUME_RENDER_TIMEOUT_MS = 120_000;
const RESUME_RENDER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ResumeHtmlPdfRenderInput {
  readonly htmlPath: string;
  readonly pdfPath: string;
}

export type ResumeHtmlPdfRenderer = (input: ResumeHtmlPdfRenderInput) => void;

export const RESUME_HTML_PDF_SCRIPT = `
import sys
from pathlib import Path

from jobctrl.infrastructure.materials.html_resume_pdf import render_resume_html_to_pdf

html_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])

render_resume_html_to_pdf(html_path.read_text(encoding="utf-8"), str(output_path))
`;

// Renders pre-built resume HTML to a full, paginated PDF via the same Playwright
// adapter the Python worker uses, so the reviewed/submitted resume matches the
// edited HTML instead of a truncated single-page fallback. Synchronous so it can
// run inside the better-sqlite3 write transactions that persist the artifact.
export const defaultResumeHtmlPdfRenderer: ResumeHtmlPdfRenderer = ({ htmlPath, pdfPath }) => {
  try {
    execFileSync(
      "uv",
      [
        "--project",
        AUTOMATION_PROJECT_DIR,
        "run",
        "python",
        "-c",
        RESUME_HTML_PDF_SCRIPT,
        htmlPath,
        pdfPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RESUME_RENDER_TIMEOUT_MS,
        maxBuffer: RESUME_RENDER_MAX_BUFFER_BYTES,
      },
    );
  } catch (error) {
    throw new Error(resumeRenderErrorMessage(error));
  }
};

function resumeRenderErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const { stderr } = error as { stderr?: Buffer | string | null };
    const text = (typeof stderr === "string" ? stderr : stderr?.toString("utf8"))?.trim();
    if (text) {
      return `Resume HTML-to-PDF render failed: ${text}`;
    }
  }
  return `Resume HTML-to-PDF render failed: ${error instanceof Error ? error.message : String(error)}`;
}
