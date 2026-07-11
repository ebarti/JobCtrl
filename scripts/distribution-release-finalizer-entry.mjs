import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { main } from "./distribution-release.mjs";
export {
  privateKeyFromBase64,
  releasePublicKeyBase64,
} from "./distribution-release.mjs";

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`distribution release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
