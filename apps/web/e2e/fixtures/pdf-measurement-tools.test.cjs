const { test } = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_PDF_TOOLS, assertPdfMeasurementTools } = require("./pdf-measurement-tools.cjs");

test("requires every real Poppler tool before the PDF measurement lane", () => {
  const calls = [];
  assertPdfMeasurementTools((tool, args) => { calls.push([tool, args]); return { status: 0 }; });
  assert.deepEqual(calls, REQUIRED_PDF_TOOLS.map((tool) => [tool, ["-v"]]));
});

test("reports every unavailable tool and the explicit Linux preparation command", () => {
  const calls = [];
  assert.throws(() => assertPdfMeasurementTools((tool) => {
    calls.push(tool);
    return { status: tool === "pdftotext" ? 0 : null, error: { code: "ENOENT" } };
  }), /pdfinfo, pdffonts, pdftoppm.*apt-get install --yes poppler-utils/);
  assert.deepEqual(calls, REQUIRED_PDF_TOOLS);
});
