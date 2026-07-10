# Distribution Contract

This directory is the machine-readable boundary between JobCtrl source
development and the installed product.

- `manifest.schema.json` defines the signed per-artifact manifest.
- `component-inventory.json` classifies top-level runtime, optional-capability,
  provider-pack, and developer-only components.
- `components.lock.json` pins the seven external runtime/browser/native
  archives that sit outside pnpm and uv ecosystem lockfiles by immutable URL
  and SHA-256.
- `payload-layout.json` assigns every bundled top-level component exactly one
  non-overlapping payload root.
- `provider-packs.lock.json` records the exact, independently installable wheel
  closure for each non-redistributed provider pack.
- `license-evidence.lock.json` and `node-license-evidence.lock.json` pin the
  immutable upstream evidence used when installed packages omit license text.
- `playwright-mcp/` and `api-native/` contain isolated production-only pnpm
  closures for the MCP runtime and the API's native SQLite binding. Install
  scripts are disabled; the native binary comes only from `components.lock.json`.
- `capability-policy.json` fixes the required capabilities, their safe defaults,
  and the bundled components each capability may invoke.
- `platforms.json` defines supported targets, launcher compatibility, signing
  policy, and the required core closure.
- `source-baseline.json` records reproducible counts for the current source
  dependency declarations separately from a commit-anchored observational
  source-install footprint snapshot.
- `LICENSE-REVIEW.md` records the fail-closed top-level license and
  redistribution decision. It also identifies the transitive SBOM and
  attribution gates that production builds and stable promotion must pass.
- `signing-policy.json` names the required trust identities and records whether
  stable promotion is externally unblocked; it never stores private material.
- `scripts/distribution-manifest.mjs` validates these contracts and generates
  deterministic file inventories and source/payload footprint reports.
- `scripts/distribution-build.mjs` assembles either a tiny deterministic test
  fixture or the real production payload, emits release metadata, audits every
  file and Mach-O, creates a deterministic archive, and smoke-tests a clean
  extraction.

The inventory records top-level components; the release SBOM records every
transitive package, binary, dynamic library, and license. A production builder
must fail when a payload component is absent from the inventory, marked
developer-only, not approved for bundling, or missing its required attribution.

The manifest's `files` array covers every regular file and symbolic link except
`manifest.json` itself and its detached `manifest.sig`; those two files form the
signed envelope and cannot self-hash. SBOM, licenses, notices, provenance, and
size reports live under the `jobctrl-release-metadata` component and are fully
owned by the file inventory. Artifact verification must enumerate the extracted
tree, allow only those two fixed envelope exclusions, and require exact equality
with `files` before activation.

Component `sha256` is the SHA-256 of its owned, printable-ASCII path-sorted
records. Regular files encode as
`path NUL file NUL file-sha256 NUL sizeBytes NUL mode LF`; symlinks encode as
`path NUL symlink NUL relative-target NUL target-byte-length LF`. Component
`sizeBytes` is the sum of regular-file sizes and symlink-target byte lengths.
Component roots may not overlap,
regular-file modes are normalized to `0644` or `0755`, and symlinks must be
relative, normalized, non-cyclic, resolvable, and confined to their owning
component. The ASCII path contract makes JavaScript and Go byte ordering
identical while preserving the pinned Chromium app's signed framework links.
All three current provider runtimes remain `official-download`: JobCtrl may
fetch and verify their official artifacts into managed provider packs, but it
cannot republish them until the component-specific evidence in
`LICENSE-REVIEW.md` is complete. This preserves provider functionality without
silently treating a package label as permission for its embedded binaries.
The installer retains the exact signed-lock wheel closure inside each managed
pack. Every activation rechecks each wheel's size and SHA-256, deterministically
re-extracts that closure, and requires the resulting canonical tree digest to
match live `site-packages`; mutable `active.json` and `pack.json` state cannot
authorize replacement code. Provider paths are appended after the core runtime,
core-distribution overlap is rejected, and overlap between active provider packs
is allowed only when the signed wheel records are identical.

## Initial platform gate

The first release target is Apple-silicon macOS with a declared minimum of
macOS 15.0. The floor is set by the full pinned provider/runtime closure, not by
wheel tags; every Mach-O file is checked against that deployment target. Builder
tools installed on a newer host are not assumed to be redistributable: for
example, a Homebrew Temporal bottle compiled for the builder OS must not be
copied into the artifact.

Stable artifacts require:

- a Developer ID Application signature on executable code;
- an Ed25519-signed manifest;
- notarization and stapling;
- a complete CycloneDX SBOM and attribution directory;
- checksums and provenance published beside the archive.

Local artifacts remain explicitly unsigned and cannot be promoted to the stable
channel. Prerelease artifacts use the same release manifest key, Developer ID
code signature, and notarization gate as stable artifacts; stable promotion
also requires `stableReleaseStatus` to be `ready`.

## Production payload builder

The real builder downloads only the seven locked archives, verifies every
SHA-256 before extraction, and caches verified inputs under
`~/Library/Caches/JobCtrl/distribution`. It builds the API and web app, installs
the Python core closure without provider extras, embeds the pinned browser and
native SQLite binding, and writes the payload, deterministic `.tar.gz`,
`build-result.json`, `size-report.json`, and build evidence under `dist/`.
The Python assembly removes the unreachable Tcl/Tk GUI closure and normalizes
installer-generated `RECORD` and CycloneDX metadata against
`SOURCE_DATE_EPOCH`, so two real builds from one source identity are bytewise
comparable.

Both size reports keep the signed payload total non-overlapping while listing
all 16 bundled inventory components. Embedded/shared drill-down rows cover the
three-package better-sqlite3 closure, emitted font assets, the PDF.js assets
owned by the web build, and the system-browser adapter's exclusive modules.
The three provider packs remain artifact-excluded and report their exact locked
wheel download bytes; extracted installed size belongs to state-owned
activation reporting, not the signed core total.

Before success, it extracts the archive with the stock macOS `tar` and runs the
bundled Node, Python, Temporal server, long-lived worker, API, web app, Chromium,
and PDF.js paths with a stock system `PATH`. Runtime children execute under a
macOS sandbox that denies non-loopback outbound IP connections; the smoke test
proves the denial with an `EPERM` probe, submits an ephemeral saved-HTML capture
through the extension API and its production Temporal workflow, reads the job
and workflow projection back, renders production HTML to PDF, and renders the
first PDF page in bundled Chromium. It then stops the full stack, restarts from
the same extracted payload plus persisted Temporal/JobCtrl state, and proves a
fresh worker heartbeat, stable DB identity, retained job, and completed Temporal
run. The extracted payload tree is compared with the manifest again after all
smoke processes exit.

`SOURCE_DATE_EPOCH` controls archive timestamps and defaults to `0`. The local
builder deliberately emits an unsigned, non-promotable artifact; signing and
notarization are a separate release stage.

## Commands

```bash
corepack pnpm distribution:audit
corepack pnpm distribution:provider-lock:check
corepack pnpm distribution:provider-lock:generate
corepack pnpm distribution:build:fixture
SOURCE_DATE_EPOCH=0 corepack pnpm distribution:build
SOURCE_DATE_EPOCH=0 corepack pnpm distribution:build -- --baseline-size-report /path/to/previous/size-report.json
corepack pnpm distribution:measure
corepack pnpm distribution:measure -- --root /path/to/checkout
corepack pnpm distribution:measure -- --artifact /path/to/extracted/payload
```
