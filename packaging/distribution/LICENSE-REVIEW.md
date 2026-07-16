# Distribution License Review

This is the fail-closed distribution decision for every top-level component in
`component-inventory.json`. It is an engineering release control, not legal
advice. `bundle` means the named top-level component may enter a JobCtrl-built
artifact only when its pinned source, license text, notices, and file ownership
all pass the manifest checks. `official-download` means JobCtrl may download and
verify the component from the named provider, but must not republish it.
`exclude` means the component may not enter a user artifact.

An unlisted component, a changed source or license, or an artifact without the
required notice is denied by default. Update both this review and
`component-inventory.json` before changing a distribution decision.

## Top-level decisions

| Component | Inventory class | Inventory license | Inventory decision | Release gate |
| --- | --- | --- | --- | --- |
| `jobctrl-launcher` | `core-runtime` | `AGPL-3.0-only` | `bundle` | Ship JobCtrl license and Go standard-library notices from the release SBOM. |
| `jobctrl-api` | `core-runtime` | `AGPL-3.0-only` | `bundle` | Ship JobCtrl license; include its resolved production dependency notices. |
| `jobctrl-web` | `core-runtime` | `AGPL-3.0-only` | `bundle` | Ship JobCtrl license; include bundled asset and production dependency notices. |
| `jobctrl-worker` | `core-runtime` | `AGPL-3.0-only` | `bundle` | Ship JobCtrl license; include its resolved Python runtime dependency notices. |
| `jobctrl-release-metadata` | `core-runtime` | `AGPL-3.0-only` | `bundle` | Own the generated SBOM, license texts, notices, provenance, and component-size report; fail when any payload file lacks attribution. |
| `better-sqlite3-native` | `core-runtime` | `MIT` | `bundle` | Embedded in `jobctrl-api`; verify the pinned Node 22 ABI 127 darwin-arm64 prebuild and ship the better-sqlite3 license. Never run an unpinned prebuild installer. |
| `font-jetbrains-mono` | `core-runtime` | `OFL-1.1` | `bundle` | Embedded in `jobctrl-web`; ship the OFL text and JetBrains/Fontsource attribution. |
| `font-geist` | `core-runtime` | `OFL-1.1` | `bundle` | Embedded in `jobctrl-web`; ship the OFL text and Geist Project/Fontsource attribution. |
| `node-runtime` | `core-runtime` | `MIT` | `bundle` | Verify the pinned upstream archive and ship Node.js license and notices. |
| `python-runtime` | `core-runtime` | `PSF-2.0` | `bundle` | Verify the pinned python-build-standalone archive and ship CPython plus included-library notices. |
| `temporal-runtime` | `core-runtime` | `MIT` | `bundle` | Use the pinned upstream source/artifact built for the declared target; ship Temporal notices. |
| `pdfjs-renderer` | `core-runtime` | `Apache-2.0` | `bundle` | Ship Apache-2.0 and required PDF.js notices. Poppler is not part of this component. |
| `playwright-python` | `core-runtime` | `Apache-2.0` | `bundle` | Resolve the exact locked package and ship Playwright notices. |
| `chromium-core` | `core-runtime` | `BSD-3-Clause` | `bundle` | Ship the pinned Playwright headless-shell artifact and Chromium's complete third-party notices. The full Chrome-for-Testing bundle is excluded because its Widevine CDM has separate commercial redistribution terms. |
| `playwright-mcp` | `core-runtime` | `Apache-2.0` | `bundle` | Verify the exact locked npm artifact and ship its license and transitive notices. |
| `system-browser-adapter` | `optional-capability` | `AGPL-3.0-only` | `bundle` | Embedded in `jobctrl-worker`; the adapter contains no browser or profile. Browser adoption requires explicit user enablement and consent. |
| `claude-agent-sdk` | `provider-pack` | `MIT AND LicenseRef-Anthropic-Commercial-Terms` | `official-download` | The SDK package is MIT, while the included provider runtime remains subject to Anthropic's terms. No explicit redistribution grant for that runtime has been established. P1 may fetch and hash-verify the official wheel into a managed provider pack; JobCtrl releases must not republish it unless an explicit grant is recorded here. |
| `codex-provider-runtime` | `provider-pack` | `Apache-2.0` | `official-download` | The exact wheel omits all license/notice files while embedding Codex, ripgrep, and patched zsh with separate terms. P1 may fetch and hash-verify it as a managed provider pack. Republishing remains denied until the Codex, ripgrep, zsh, and Rust transitive license/notice closure is recorded and shipped. |
| `antigravity-provider-runtime` | `provider-pack` | `Apache-2.0` | `official-download` | The exact wheel includes its top-level license but embeds an internal-MPM `localharness` binary without a recoverable Go module or third-party notice closure. P1 may fetch and hash-verify it as a managed provider pack. Republishing remains denied until Google supplies the closure or written permission. |
| `source-development-toolchain` | `developer-only` | `NOASSERTION` | `exclude` | Git, Go, pnpm, Corepack, uv, test, docs, and development tools never enter the user artifact. |
| `poppler-source-compatibility` | `developer-only` | `GPL-2.0-only OR GPL-3.0-only` | `exclude` | P1 removed the Poppler-only preview route. Poppler is not a source or bundled-product prerequisite and must not enter the artifact. |

## Transitive gate

P0 records top-level ownership and the default distribution decision; the
production and release builders own the transitive proof.

- The P1 production builder generates a complete CycloneDX SBOM and attribution
  directory from the actual payload. It fails on an unclassified file,
  dependency, dynamic library, browser notice, font notice, or missing license.
- The protected P6 release job reruns that policy on the exact signed artifact
  and blocks stable promotion when the SBOM, attribution set, pinned-source
  evidence, or this top-level decision is incomplete.
- Provider terms are checked independently of an open-source package label.
  Ambiguity resolves to `official-download` or `exclude`, never implicit
  republication.
