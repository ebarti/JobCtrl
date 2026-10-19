// System dependencies of the real cover-letter PDF measurement lane.
// Preparation installs these explicitly; tests never install or skip them.
const { spawnSync } = require("node:child_process");
const REQUIRED_PDF_TOOLS = Object.freeze(["pdfinfo", "pdffonts", "pdftotext", "pdftoppm"]);

function assertPdfMeasurementTools(run = spawnSync) {
  const missing = REQUIRED_PDF_TOOLS.filter((tool) => run(tool, ["-v"], { encoding: "utf8" }).status !== 0);
  if (missing.length) {
    throw new Error(`Required Poppler PDF measurement tools unavailable: ${missing.join(", ")}. ` +
      "Prepare Linux/CI with: sudo apt-get update && sudo apt-get install --yes poppler-utils; " +
      "or macOS with: brew install poppler. PDF measurements are required and will not be skipped.");
  }
}

module.exports = { REQUIRED_PDF_TOOLS, assertPdfMeasurementTools };
if (require.main === module) assertPdfMeasurementTools();
