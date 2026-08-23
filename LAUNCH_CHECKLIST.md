# JobCtrl Public Launch Status

JobCtrl's current early-access line is `0.1.x`; the `v0.1.1` release candidate
advances the published `v0.1.0` build without changing product data, database
schemas, launcher protocols, or signed-release security counters. The withdrawn
pre-launch `2.0.x` numbering remains preserved in tags, releases, signatures,
and immutable artifacts. The detailed release and recovery record remains in
[`docs/publish-checklist.md`](docs/publish-checklist.md).

## Live Public Surfaces

- [x] Public source repository, issue intake, documentation, and security
  reporting.
- [x] Interactive browser demo using synthetic data.
- [x] Signed and notarized Apple-silicon macOS release with immutable release
  evidence.
- [x] Public installer at `https://jobctrl.dev/install.sh`.
- [x] Homebrew installation through `ebarti/tap/jobctrl`.
- [x] Public product tour, safety documentation, and evidence-backed comparison.

## Remaining Distribution Follow-Up

- [x] Publish and verify the `0.1.0` early-access Python package, then yank the
  preserved `2.0.7` and `2.0.8` files without deleting them.
- [ ] Publish and verify `v0.1.1` through signed stable sequence 4, then cut the
  canonical installers over to its immutable release assets.
- [ ] Complete the published-artifact, lifecycle, clean-machine, and real-path
  TTFV acceptance matrix recorded in `docs/publish-checklist.md`.

Public users should install JobCtrl with the bundled installer or Homebrew.
The PyPI package is a verified component distribution, not the complete bundled
application install path.
