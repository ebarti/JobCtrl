import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const readRepoFile = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ");

describe("credential and browser privacy documentation contract", () => {
  it("distinguishes discovery browsers from application-submission automation", () => {
    const dataSafety = readRepoFile("docs/user/data-and-safety.md");

    expect(dataSafety).toContain("Discovery or enrichment may launch a browser?");
    expect(dataSafety).toContain("Smart extraction and some detail enrichment use Playwright");
    expect(dataSafety).toContain("Application-submission browser automation always running?");
    expect(dataSafety).not.toContain("Browser/apply automation always running?");
  });

  it("keeps the README credential lifecycle and local-data protections complete", () => {
    const readme = normalizeWhitespace(readRepoFile("README.md"));

    expect(readme).toContain("plaintext, cross-platform fallback");
    expect(readme).toContain("On macOS only, Settings can");
    expect(readme).toContain("only a missing or empty allowlisted value");
    expect(readme).toContain("Keychain edits are not hot-reloaded");
    expect(readme).toContain("Windows Credential Manager");
    expect(readme).toContain("Linux Secret Service/keyring");
    expect(readme).toContain("an unknown (`inspection_failed`) result means Keychain could not be inspected");
    expect(readme).toContain("Unlock Keychain if it is locked, then retry");
    expect(readme).toContain("The release privacy check adds a second guard");
  });

  it("keeps the API and runtime process boundary explicit", () => {
    const runtime = normalizeWhitespace(readRepoFile("docs/architecture/runtime.md"));
    const completeApi = normalizeWhitespace(readRepoFile("docs/api/complete-contract.md"));

    expect(runtime).toContain("### Provider Credential Boundary");
    expect(runtime).toContain("passes that value to the `JobCtrl` macOS Keychain service");
    expect(runtime).toContain("same fixed allowlist");
    expect(runtime).toContain("`configured` state is `true`, `false`, or `null`");
    expect(runtime).toContain("`unavailableReason: inspection_failed`");
    expect(runtime).toContain("sanitized `503 credential_store_unavailable`");
    expect(runtime).toContain("only into that process's environment");
    expect(runtime).toContain("There is no hot reload");
    expect(completeApi).toContain("`PATCH /v1/credentials` receives the submitted value");
    expect(completeApi).toContain("`GET` and `DELETE` never return stored values");
    expect(completeApi).toContain("never reads a stored value back for provider runtime use");
    expect(completeApi).toContain("`unavailableReason` as `unsupported_platform`, `inspection_failed`, or `null`");
    expect(completeApi).toContain("`503 credential_store_unavailable` with reason `operational_failure`");
  });

  it("preserves owner-signoff state for credential claims", () => {
    const claims = readRepoFile("docs/claims-ledger.md");

    expect(claims).toContain("[x] CL-064 — owner-approved `Current` on 2026-07-09");
    expect(claims).toContain("[x] CL-085 — owner-approved `Roadmap` on 2026-07-10");
  });
});
