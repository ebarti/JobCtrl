import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("public onboarding leads with bundled acquisition and keeps source advanced", async () => {
  const gettingStarted = await read("docs/user/getting-started.md");
  const readme = await read("README.md");

  for (const document of [gettingStarted, readme]) {
    assert.match(document, /curl -fsSL https:\/\/jobctrl\.dev\/install\.sh \| sh/);
    assert.match(document, /brew install ebarti\/tap\/jobctrl/);
    assert.match(document, /jobctrl start/);
  }

  const installer = gettingStarted.indexOf("### Recommended: bundled installer");
  const homebrew = gettingStarted.indexOf("### Homebrew");
  const source = gettingStarted.indexOf("### Build and run from source");
  assert.ok(installer >= 0 && installer < homebrew && homebrew < source);
  assert.match(gettingStarted, /Only this option requires Git/);
  assert.doesNotMatch(gettingStarted, /^## \d+\. Source-Checkout Requirements$/m);

  const publicCopy = [
    readme,
    gettingStarted,
    await read("ROADMAP.md"),
    await read("docs/local-development.md"),
    await read("docs/architecture/index.md"),
    await read("docs/architecture/runtime.md"),
    await read("docs/user/normal-flows.md"),
    await read("docs/user/configuration.md"),
    await read("docs/user/data-and-safety.md"),
  ].join("\n");
  assert.doesNotMatch(
    publicCopy,
    /not published yet|not public yet|only public path|current public path|after the first signed bundled release|public channel remains blocked|unpublished bundled product/i,
  );

  const claimsLedger = await read("docs/claims-ledger.md");
  assert.match(claimsLedger, /\| CL-082 \|[^\n]+\| Roadmap \|/);
  assert.match(claimsLedger, /> \*\*Launch-cutover draft\.\*\*/);
  assert.match(claimsLedger, /must not be\n> merged or deployed while CL-082 remains `Roadmap`/);
});

test("comparison omits the annotated recommendation and methodology sections", async () => {
  const comparison = await read("docs/comparison.md");

  assert.doesNotMatch(comparison, /^## Which operating style fits\?$/m);
  assert.doesNotMatch(comparison, /^## Method and limitations$/m);
  assert.doesNotMatch(comparison, /^### Reading the statuses$/m);
  assert.doesNotMatch(comparison, /jh-compare-fit-grid/);
  assert.match(comparison, /^## Appendix: evidence-backed capability matrix$/m);
});
