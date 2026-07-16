import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import docsScreenshotWorkspace from "../apps/web/e2e/fixtures/docs-screenshot-workspace.cjs";

const {
  DIRECTORY_PREFIX,
  OWNERSHIP_MARKER,
  assertOwnedDocsScreenshotDirectory,
  canonicalTemporaryRoot,
  canonicalTemporaryRoots,
  createOwnedDocsScreenshotDirectory,
  prepareOwnedDocsScreenshotDirectory,
} = docsScreenshotWorkspace;
const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

test("docs screenshot workspaces reject the exact temporary root", async () => {
  for (const temporaryRoot of await canonicalTemporaryRoots()) {
    await assert.rejects(
      createOwnedDocsScreenshotDirectory(temporaryRoot),
      /must be a strict descendant/,
    );
    await assert.rejects(
      assertOwnedDocsScreenshotDirectory(temporaryRoot),
      /must be a strict descendant/,
    );
    await assert.rejects(
      prepareOwnedDocsScreenshotDirectory(temporaryRoot),
      /must be a strict descendant/,
    );
  }
});

test("docs screenshot workspace parents must be existing temp directories", async (t) => {
  const temporaryRoot = await canonicalTemporaryRoot();
  const fixtureRoot = await fs.mkdtemp(
    path.join(temporaryRoot, "jobctrl-docs-guard-test-"),
  );
  t.after(() => fs.rm(fixtureRoot, { force: true, recursive: true }));
  const filePath = path.join(fixtureRoot, "not-a-directory");
  await fs.writeFile(filePath, "fixture", "utf8");

  await assert.rejects(
    createOwnedDocsScreenshotDirectory(filePath),
    /must be a directory/,
  );
  await assert.rejects(
    createOwnedDocsScreenshotDirectory(repoRoot),
    /must be a strict descendant/,
  );
});

test("docs screenshot workspace parents reject symlink escapes", async (t) => {
  const temporaryRoot = await canonicalTemporaryRoot();
  const fixtureRoot = await fs.mkdtemp(
    path.join(temporaryRoot, "jobctrl-docs-symlink-test-"),
  );
  t.after(() => fs.rm(fixtureRoot, { force: true, recursive: true }));
  const escape = path.join(fixtureRoot, "escape");
  try {
    await fs.symlink(repoRoot, escape, "dir");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["EACCES", "ENOTSUP", "EPERM"].includes(error.code)
    ) {
      t.skip(`Directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    createOwnedDocsScreenshotDirectory(escape),
    /must be a strict descendant/,
  );
});

test("docs screenshot workspaces are unique owned children", async (t) => {
  const temporaryRoot = await canonicalTemporaryRoot();
  const parent = await fs.mkdtemp(
    path.join(temporaryRoot, "jobctrl-docs-parent-test-"),
  );
  t.after(() => fs.rm(parent, { force: true, recursive: true }));
  const parentSentinel = path.join(parent, "caller-parent.txt");
  await fs.writeFile(parentSentinel, "preserved", "utf8");

  const first = await createOwnedDocsScreenshotDirectory(parent);
  const second = await createOwnedDocsScreenshotDirectory(parent);
  const defaultChild = await createOwnedDocsScreenshotDirectory();
  t.after(() => fs.rm(defaultChild, { force: true, recursive: true }));

  assert.notEqual(first, second);
  assert.equal(path.dirname(first), parent);
  assert.equal(path.dirname(second), parent);
  assert.equal(await fs.readFile(parentSentinel, "utf8"), "preserved");
  assert.equal(path.dirname(defaultChild), temporaryRoot);
  assert.ok(path.basename(first).startsWith(DIRECTORY_PREFIX));
  assert.ok(path.basename(defaultChild).startsWith(DIRECTORY_PREFIX));
  assert.equal(await assertOwnedDocsScreenshotDirectory(first), first);

  const unowned = await fs.mkdtemp(path.join(parent, DIRECTORY_PREFIX));
  const sentinel = path.join(unowned, "must-survive.txt");
  await fs.writeFile(sentinel, "caller-owned", "utf8");
  await assert.rejects(
    prepareOwnedDocsScreenshotDirectory(unowned),
    /lacks a valid ownership marker/,
  );
  assert.equal(await fs.readFile(sentinel, "utf8"), "caller-owned");

  await fs.rm(path.join(first, OWNERSHIP_MARKER));
  await assert.rejects(
    assertOwnedDocsScreenshotDirectory(first),
    /lacks a valid ownership marker/,
  );
});
