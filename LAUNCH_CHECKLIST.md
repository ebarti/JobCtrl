# JobCtrl Public Launch Status

JobCtrl launched its first stable public macOS release,
[`v2.0.7`](https://github.com/ebarti/JobCtrl/releases/tag/v2.0.7), on
2026-07-24. The detailed release and recovery record remains in
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

- [ ] Publish and verify the supported `2.0.7` Python package through the
  protected PyPI recovery path. The current `0.0.1` package is an identity
  marker and is not a JobCtrl application install path.

Public users should install JobCtrl with the bundled installer or Homebrew.
Do not advertise `pip install jobctrl` until the supported package publication
and verification are complete.
