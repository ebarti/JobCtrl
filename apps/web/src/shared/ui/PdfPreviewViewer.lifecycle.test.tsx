import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  Util: { transform: vi.fn() },
  getDocument: pdfMocks.getDocument,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => ({}));

import { PdfPreviewViewer } from "./PdfPreviewViewer.js";

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();

const viewerProps = {
  loadingMessage: "Loading resume preview.",
  loadingTitle: "Loading preview",
  pageAltPrefix: "Tailored resume",
  title: "Resume preview",
  url: "/v1/artifacts/resume/preview.pdf",
};

interface PageOptions {
  renderPromise?: Promise<void>;
}

function createPage(options: PageOptions = {}) {
  const cleanup = vi.fn();
  const renderPromise = options.renderPromise ?? Promise.resolve();
  return {
    cleanup,
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      height: 800 * scale,
      transform: [scale, 0, 0, scale, 0, 0],
      width: 600 * scale,
    })),
    render: vi.fn(() => ({ promise: renderPromise })),
  };
}

function installPdfDocument(
  pages: ReturnType<typeof createPage>[],
  onDestroy?: () => void,
) {
  const destroy = vi.fn(async () => {
    onDestroy?.();
  });
  const pdfDocument = {
    destroy,
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
    numPages: pages.length,
  };
  const loadingTask = {
    destroy: vi.fn(async () => undefined),
    promise: Promise.resolve(pdfDocument),
  };
  pdfMocks.getDocument.mockReturnValue(loadingTask);
  return { destroy, loadingTask, pdfDocument };
}

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
});

beforeEach(() => {
  pdfMocks.getDocument.mockReset();
  createObjectURL.mockReset();
  revokeObjectURL.mockReset();
  createObjectURL.mockImplementation(() => `blob:pdf-page-${createObjectURL.mock.calls.length}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]))));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["png"], { type: "image/png" }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

describe("PdfPreviewViewer resource lifecycle", () => {
  it("keeps the accessible page image and caption while mounted, then revokes its Blob URL", async () => {
    const page = createPage();
    const { destroy } = installPdfDocument([page]);
    const view = render(<PdfPreviewViewer {...viewerProps} />);

    expect(view.container.querySelector(".toolbar-status")).toHaveAttribute(
      "data-typography",
      "metadata",
    );

    const image = await screen.findByRole("img", { name: "Tailored resume page 1" });
    expect(image).toHaveAttribute("src", "blob:pdf-page-1");
    expect(screen.getByText("Page 1")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
    await waitFor(() => {
      expect(page.cleanup).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf-page-1");
  });

  it("revokes completed pages and exposes the error state when a later page fails", async () => {
    const firstPage = createPage();
    const secondPage = createPage({ renderPromise: Promise.reject(new Error("page two failed")) });
    const { destroy } = installPdfDocument([firstPage, secondPage]);
    render(<PdfPreviewViewer {...viewerProps} />);

    expect(await screen.findByText("Preview failed")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("page two failed");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(firstPage.cleanup).toHaveBeenCalledTimes(1);
      expect(secondPage.cleanup).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf-page-1");
    });
  });

  it("destroys the open document and cleans up the active page when rendering is cancelled", async () => {
    let rejectRender!: (error: Error) => void;
    const renderPromise = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const page = createPage({ renderPromise });
    const { destroy, loadingTask } = installPdfDocument([page], () => {
      rejectRender(new Error("render cancelled"));
    });
    const view = render(<PdfPreviewViewer {...viewerProps} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));

    view.unmount();

    await waitFor(() => {
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(page.cleanup).toHaveBeenCalledTimes(1);
    });
    expect(loadingTask.destroy).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
