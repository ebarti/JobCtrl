import { describe, expect, it, vi } from "vitest";

import { pdfTextLines, type PdfAuditLineTarget } from "./pdf-audit-lines.js";
import { renderPdfPageToObjectUrl, renderedLinesFromLayoutBoxes } from "./PdfPreviewViewer.js";

const pdfjs = {
  Util: {
    transform: (_viewportTransform: readonly number[], itemTransform: readonly number[]) => itemTransform,
  },
} as Parameters<typeof pdfTextLines>[0];

const viewport = {
  height: 1000,
  transform: [1, 0, 0, 1, 0, 0],
  width: 800,
};

function textItem(str: string, left: number, baseline: number, width = 360) {
  return {
    str,
    transform: [1, 0, 0, 10, left, baseline],
    width,
  };
}

describe("PdfAuditPreviewViewer line geometry", () => {
  it("uses persisted layout boxes as selectable resume lines when available", () => {
    const lines = renderedLinesFromLayoutBoxes(2, [
      {
        semanticId: "experience:acme:bullet:1",
        pageNumber: 1,
        lineNumber: 6,
        textExcerpt: "Wrong page.",
        leftPct: 1,
        topPct: 2,
        widthPct: 3,
        heightPct: 4,
      },
      {
        semanticId: "experience:acme:bullet:2",
        pageNumber: 2,
        lineNumber: 7,
        textExcerpt: "Cut latency.",
        leftPct: 12.5,
        topPct: 24,
        widthPct: 62,
        heightPct: 2.4,
      },
    ]);

    expect(lines).toEqual([
      {
        heightPct: 2.4,
        leftPct: 12.5,
        resumeLineNumber: 7,
        resumeLineText: "Cut latency.",
        text: "Cut latency.",
        topPct: 24,
        widthPct: 62,
      },
    ]);
  });

  it("treats wrapped PDF rows for one resume line as one cohesive target", () => {
    const targets: PdfAuditLineTarget[] = [
      { lineNumber: 4, text: "Executive Profile" },
      {
        lineNumber: 5,
        text:
          "Director of Engineering with 12+ years of experience leading high-growth product and platform organizations while remaining close to architecture and systems design. Experienced in driving modern engineering practices, including AI-assisted developer workflows and cloud-native scalability, to accelerate product delivery in fast-paced environments.",
      },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [
        textItem("Executive Profile", 80, 120, 180),
        textItem("Engineering Director with 12+ years of experience leading platform organizations at high-growth", 80, 160, 520),
        textItem("scale-ups. Deeply technical leader who remains close to distributed systems architecture and engineering quality", 80, 174, 590),
        textItem("while scaling teams. Experienced in driving modern engineering practices, including AI-assisted developer workflows", 80, 188, 610),
        textItem("and cloud-native scalability, to accelerate product delivery in fast-paced environments.", 80, 202, 470),
      ],
      viewport,
      targets,
    );

    const profileTargets = lines.filter((line) => line.resumeLineNumber === 5);

    expect(lines.map((line) => line.resumeLineNumber)).toEqual([4, 5]);
    expect(profileTargets).toHaveLength(1);
    expect(profileTargets[0]?.text).toContain("fast-paced environments");
    expect(profileTargets[0]?.heightPct).toBeGreaterThan(5);
  });

  it("does not let short section headings claim prose rows containing the heading word", () => {
    const targets: PdfAuditLineTarget[] = [
      {
        lineNumber: 5,
        text: "Director of Engineering with 12+ years of experience leading high-growth product and platform organizations.",
      },
      { lineNumber: 7, text: "EXPERIENCE" },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [textItem("Engineering Director with 12+ years of experience leading platform organizations.", 80, 160, 430)],
      viewport,
      targets,
    );

    expect(lines[0]?.resumeLineNumber).toBe(5);
  });

  it("does not map prose to a short section heading when no long claim target exists", () => {
    const lines = pdfTextLines(
      pdfjs,
      [textItem("Engineering Director with 12+ years of experience leading platform organizations.", 80, 160, 430)],
      viewport,
      [{ lineNumber: 7, text: "EXPERIENCE" }],
    );

    expect(lines[0]?.resumeLineNumber).toBeNull();
  });

  it("does not attach following prose rows to long contact targets", () => {
    const targets: PdfAuditLineTarget[] = [
      {
        lineNumber: 2,
        text: "candidate@example.test | (+1) 555-0104 | https://portfolio.example.test | https://linkedin.com/in/example",
      },
      {
        lineNumber: 5,
        text: "Director of Engineering with 12+ years of experience leading high-growth product and platform organizations.",
      },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [
        textItem("candidate@example.test • (+1) 555-0104 • portfolio.example.test", 80, 120, 360),
        textItem("Director of Engineering with 12+ years of experience leading platform organizations.", 80, 136, 430),
      ],
      viewport,
      targets,
    );

    expect(lines.map((line) => line.resumeLineNumber)).toEqual([2, 5]);
  });

  it("does not let tiny date fragments claim compact metadata lines", () => {
    const targets: PdfAuditLineTarget[] = [
      { lineNumber: 9, text: "Harbor City (Remote) | Mar 2024 -- Present" },
      { lineNumber: 22, text: "Riverton, USA | Jul 2023 -- Mar 2024" },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [
        textItem("Mar 2024", 520, 120, 70),
        textItem("Riverton, USA Jul 2023 Mar 2024", 80, 145, 310),
      ],
      viewport,
      targets,
    );

    expect(lines.map((line) => line.resumeLineNumber)).toEqual([null, 22]);
  });

  it("stops long bullet continuation boxes before unrelated following rows", () => {
    const targets: PdfAuditLineTarget[] = [
      {
        lineNumber: 36,
        text:
          "- Preserved the pilot market under aggressive compliance deadlines by leading the cross-functional task force for the Fleet Safety regulation, partnering with Product, Legal, and Operations.",
      },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [
        textItem("Preserved the pilot market under aggressive compliance deadlines by leading the cross-functional task force", 80, 120, 560),
        textItem("for the Fleet Safety regulation, partnering with Product, Legal, and Operations.", 80, 134, 460),
        textItem("Reliability Advisory Board Member Sep 2022 Aug 2023", 80, 148, 390),
        textItem("Influenced the product roadmap for enterprise-grade observability and security tools.", 80, 162, 520),
      ],
      viewport,
      targets,
    );

    expect(lines.map((line) => line.resumeLineNumber)).toEqual([36, null, null]);
    expect(lines[0]?.text).toContain("Operations");
    expect(lines[0]?.text).not.toContain("Reliability Advisory");
    expect(lines[0]?.heightPct).toBeLessThan(4);
  });

  it("keeps heading rows separate while grouping wrapped bullet blocks", () => {
    const targets: PdfAuditLineTarget[] = [
      { lineNumber: 61, text: "Software Engineer | Northstar Robotics" },
      { lineNumber: 62, text: "Riverton & Lakeview, USA | Feb 2016 -- Nov 2018" },
      {
        lineNumber: 63,
        text:
          "- Designed the conveyor control layers for autonomous warehouse assembly automation and led 15 engineers through testing and deployment to get it running at production scale.",
      },
      {
        lineNumber: 64,
        text:
          "- Wrote Python APIs for real-time factory floor communication, giving the Factory Operating Platform (FOP) fast, high-volume links to the industrial control systems.",
      },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [
        textItem("Northstar Robotics Riverton & Lakeview, USA", 80, 120, 330),
        textItem("Software Engineer Northstar Robotics Feb 2016 – Nov 2018", 80, 134, 420),
        textItem(
          "○ Designed the conveyor control layers for autonomous warehouse assembly automation and led 15 engineers through testing and",
          80,
          158,
          610,
        ),
        textItem("deployment to get it running at production scale.", 100, 172, 330),
        textItem(
          "○ Wrote Python APIs for real-time factory floor communication, giving the Factory Operating Platform (FOP) fast,",
          80,
          196,
          610,
        ),
        textItem("high-volume links to the industrial control systems.", 100, 210, 340),
      ],
      viewport,
      targets,
    );

    expect(lines.map((line) => line.resumeLineNumber)).toEqual([null, 61, 63, 64]);
    expect(lines[2]?.text).toContain("deployment to get it running at production scale");
    expect(lines[2]?.heightPct).toBeGreaterThan(3);
    expect(lines[3]?.text).toContain("high-volume links to the industrial control systems");
    expect(lines[3]?.heightPct).toBeGreaterThan(3);
  });

  it("does not match later generic rows to long bullets that only share a few words", () => {
    const targets: PdfAuditLineTarget[] = [
      {
        lineNumber: 36,
        text:
          "- Preserved the pilot market under aggressive compliance deadlines by leading the cross-functional task force for the Fleet Safety regulation, partnering with Product, Legal, and Operations.",
      },
    ];

    const lines = pdfTextLines(
      pdfjs,
      [textItem("leading a cross-functional team of 15 engineers.", 80, 120, 320)],
      viewport,
      targets,
    );

    expect(lines[0]?.resumeLineNumber).toBeNull();
  });
});

describe("renderPdfPageToObjectUrl", () => {
  it("encodes every PDF page as a revocable Blob URL and releases the canvas", async () => {
    const context = {} as CanvasRenderingContext2D;
    const png = new Blob(["png"], { type: "image/png" });
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      toBlob: vi.fn((callback: BlobCallback) => callback(png)),
      width: 0,
    } as unknown as HTMLCanvasElement;
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = { render } as unknown as Parameters<typeof renderPdfPageToObjectUrl>[0];
    const renderViewport = {
      height: 1600.9,
      width: 1200.6,
    } as unknown as Parameters<typeof renderPdfPageToObjectUrl>[1];
    const objectUrl = {
      createObjectURL: vi.fn(() => "blob:local-page"),
      revokeObjectURL: vi.fn(),
    };

    const image = await renderPdfPageToObjectUrl(page, renderViewport, () => canvas, objectUrl);

    expect(image.src).toBe("blob:local-page");
    expect(render).toHaveBeenCalledWith({ canvas, canvasContext: context, viewport: renderViewport });
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(objectUrl.createObjectURL).toHaveBeenCalledWith(png);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);

    image.revoke();
    image.revoke();
    expect(objectUrl.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(objectUrl.revokeObjectURL).toHaveBeenCalledWith("blob:local-page");
  });

  it("releases the canvas when PDF.js rendering fails", async () => {
    const canvas = {
      getContext: vi.fn(() => ({} as CanvasRenderingContext2D)),
      height: 0,
      toBlob: vi.fn(),
      width: 0,
    } as unknown as HTMLCanvasElement;
    const page = {
      render: vi.fn(() => ({ promise: Promise.reject(new Error("render failed")) })),
    } as unknown as Parameters<typeof renderPdfPageToObjectUrl>[0];
    const viewport = { height: 900, width: 700 } as Parameters<typeof renderPdfPageToObjectUrl>[1];
    const objectUrl = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };

    await expect(renderPdfPageToObjectUrl(page, viewport, () => canvas, objectUrl)).rejects.toThrow("render failed");
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(objectUrl.createObjectURL).not.toHaveBeenCalled();
  });
});
