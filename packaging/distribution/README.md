# Distribution Contract

This directory is the machine-readable boundary between JobCtrl source
development and the installed product.

- `manifest.schema.json` defines the signed per-artifact manifest.
- `component-inventory.json` classifies top-level runtime, optional-capability,
  provider-pack, and developer-only components.
- `components.lock.json` pins the six external runtime/browser archives that
  sit outside pnpm and uv ecosystem lockfiles by immutable URL and SHA-256.
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

## Commands

```bash
corepack pnpm distribution:audit
corepack pnpm distribution:measure
corepack pnpm distribution:measure -- --root /path/to/checkout
corepack pnpm distribution:measure -- --artifact /path/to/extracted/payload
```
