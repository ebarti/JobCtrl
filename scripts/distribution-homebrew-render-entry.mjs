import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { main } from "./distribution-homebrew.mjs";
export { renderHomebrewFormula } from "./distribution-homebrew.mjs";

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`distribution homebrew: ${error.message}\n`);
    process.exitCode = 1;
  }
}
