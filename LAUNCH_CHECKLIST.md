# JobCtrl Public Launch Status

JobCtrl's public application version is resetting to `v0.1.0` as an
early-access release. The withdrawn pre-launch `2.0.x` numbering remains
preserved in tags, releases, signatures, and immutable artifacts; the reset
corrects maturity signaling and does not reset product data, database schemas,
launcher protocols, or signed-release security counters. The detailed release
and recovery record remains in
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

- [ ] Publish and verify the `0.1.0` early-access Python package, then yank the
  preserved `2.0.7` and `2.0.8` files without deleting them.
- [ ] Complete the published-artifact, lifecycle, clean-machine, and real-path
  TTFV acceptance matrix recorded in `docs/publish-checklist.md`.

Public users should install JobCtrl with the bundled installer or Homebrew.
The PyPI package is a verified component distribution, not the complete bundled
application install path.
