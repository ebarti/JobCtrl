# JobCtrl Launch Checklist

Keep every item unchecked until it is reverified during launch. Detailed release procedure remains in [`docs/publish-checklist.md`](docs/publish-checklist.md).

- [ ] Restore the GitHub billing/plan state and prove Actions jobs can start.
- [ ] Require owner approval and allow only `v*` tags (no branches) for `release-signing`, `release-publication`, `release-verification`, and `pypi`.
- [ ] Reverify the protected environment secret and variable names, token expiry, and PyPI Trusted Publisher configuration without exposing values.
- [ ] Confirm the retired Homebrew deploy key and repository-level secret remain absent, and the environment-scoped replacement is still limited to `ebarti/homebrew-tap`.
- [ ] Merge the native R2 publication workflow after its hosted checks can run and pass.
- [ ] Cut the audited `v*` tag from current `main`, dispatch the first signed release, and verify notarization, immutable R2 assets, channel compare-and-swap, immutable GitHub Release, Homebrew tap, and PyPI publication.
- [ ] Publish user-facing curl and Homebrew install instructions only after the hosted release path passes end to end.
