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
    expect(readme).toContain("On macOS, **Settings → Credentials** guides one of three providers");
    expect(readme).toContain("One ready provider is sufficient for all core AI stages");
    expect(readme).toContain("Secret values managed by the panel are stored in the system Keychain");
    expect(readme).toContain("AWS, Google, and Azure credential files remain owned by their vendor CLIs");
    expect(readme).toContain("a non-empty environment value takes precedence");
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
    expect(runtime).toContain("uses `PATCH /v1/credentials/batch` to replace one provider configuration");
    expect(runtime).toContain("A batch either applies completely or restores its pre-change Keychain state");
    expect(runtime).toContain("`configured` state is `true`, `false`, or `null`");
    expect(runtime).toContain("Secret values used internally for rollback are never returned, logged, persisted in SQLite, or passed to Python by the API");
    expect(runtime).toContain("then runs `codex login status` without generating model output");
    expect(runtime).toContain("same copy-once behavior used by setup");
    expect(runtime).toContain("It is read-only and never copies ambient Codex auth");
    expect(runtime).toContain("performs a non-interactive Keychain lookup only for a missing or empty value");
    expect(runtime).toContain("copied only into that process's environment");
    expect(runtime).toContain("There is no hot reload");
    expect(completeApi).toContain("`PATCH /v1/credentials/batch` validates the complete allowlisted operation plan");
    expect(completeApi).toContain("restores the exact pre-change state on failure without exposing values");
    expect(completeApi).toContain("`GET` and `DELETE` never return stored values");
    expect(completeApi).toContain("private batch snapshots are used only for compensating rollback, not provider runtime");
    expect(completeApi).toContain("`unavailableReason` as `unsupported_platform`, `inspection_failed`, or `null`");
    expect(completeApi).toContain("`503 credential_store_unavailable` with a sanitized operational or rollback failure reason");
    expect(completeApi).toContain("is the explicit mutation that may validate");
    expect(completeApi).toContain("It is read-only and never copies ambient Codex auth");
  });

  it("preserves owner-signoff state for credential claims", () => {
    const claims = readRepoFile("docs/claims-ledger.md");

    expect(claims).toContain("[x] CL-064 — owner-approved `Current` on 2026-07-09");
    expect(claims).toContain("[x] CL-085 — owner-approved `Roadmap` on 2026-07-10");
  });
});
