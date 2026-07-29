import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("brace-expansion maintenance lines apply the default output-length cap", () => {
  const defaultMaxLength = 4_000_000;

  for (const version of ["1.1.17", "2.1.3", "5.0.8"]) {
    const packagePath = path.join(
      process.cwd(),
      "node_modules",
      ".pnpm",
      `brace-expansion@${version}`,
      "node_modules",
      "brace-expansion",
    );
    const packageExport = require(packagePath);
    const expand = typeof packageExport === "function"
      ? packageExport
      : packageExport.expand;
    const expansions = expand("{a,b}".repeat(80));
    const outputLength = expansions.reduce(
      (total, expansion) => total + expansion.length,
      0,
    );

    assert.ok(expansions.length > 0, `${version} should still produce expansions`);
    assert.ok(
      outputLength <= defaultMaxLength,
      `${version} should cap expansion output at ${defaultMaxLength} characters`,
    );
  }
});
