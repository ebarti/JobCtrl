# Publish-Mechanics Checklist

> **Repository-only.** Excluded from the published docs site (registered in
> `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` + `srcExclude`, like
> `docs/backlog.md` and `docs/claims-ledger.md`). It is launch-governance, not
> user documentation.
>
> Implements Phase C of
> [`docs/plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md`](plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md)
> §9.

## Purpose and boundary

A concrete, verifiable checklist for the **mechanical** publish steps, each with
a verification and a rollback note. This checklist **prepares and verifies** the
steps; it does **not** execute them.

The **authoritative release gate is OSS spec §5**
([`docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md`](plans/implemented/2026-07-03-oss-release-remediation-spec.md)
§5 "Release gate — flipping public"). That gate owns the capability and privacy
preconditions (W0.\* privacy scanner, W1.\* apply safety, W2.\* naming/governance,
Temporal P1b–P5). This checklist does not duplicate those; it lists only the
publish *mechanics* that feed the gate. If GitHub cannot start the hosted jobs
while the repository is private, the owner may flip visibility after the
complete exact-tree local gate passes solely to unblock those runs. Docs
deployment, release tagging, Homebrew stable publication, and PyPI publication
remain prohibited until every hosted gate is then green.

## Owner-only actions (do not execute here)

Every state-changing step below is an **owner-only** action. Implementing agents
prepare and run read-only verification; the repository owner executes. The
remaining actions are governed by the release gate plus the active bundled
distribution and public-demo plans.

## Steps

### 9.1 — Repository visibility flip (owner-only)

- **Action.** Owner flips `github.com/ebarti/JobCtrl` from private to public.
- **Verification.**
  - Before the flip, run the complete local matrix on the exact `main` tree,
    including strict release/privacy scanning and built-distribution scanning.
  - Immediately after the flip, rerun Release Privacy, Docs Site, Demo Site,
    Native Launcher CI, Python CI, and TypeScript CI on that exact `main` SHA.
    `Sync Homebrew Tap` is reusable only from the later signed-release workflow;
    it is not a standalone post-flip build gate. A run with zero executed steps
    is not passing evidence. If Release Privacy fails after actually executing,
    return the repository to private while investigating. Any other hosted
    failure blocks docs/demo cutover, tagging, and publication.
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be published.
  - Every box in OSS spec §5 is checked, including the final human manual QA
    (`jobctrl doctor` clean; seeded `/apply-review` approval → dry-run
    evidence → gated submit; one harness dry-run showing blocked-channel
    evidence; no real applications).
- **Rollback.** Flip back to private. **Honest limitation:** anything fetched
  while the repository was public cannot be recalled, and git history remains
  reachable — the real mitigation is the pre-flip privacy gate, not rollback.
  OSS spec §1 records the owner's acceptance of historical blobs remaining
  reachable.

### 9.2 — Docs-site deploy and public cutover (owner-only)

- **Preconditions (OSS spec §5 gate).** Making `docs/.vitepress/dist` publicly
  reachable through the `jobctrl-docs` Cloudflare project is a going-public
  act, so it carries the **same OSS spec §5 gate as 9.1**. A candidate may be
  deployed only while it remains access-restricted. The `deploy` job in
  `docs-site.yml` is gated only on `DOCS_DEPLOY_ENABLED` and `main` — **not**
  on `release-check` — so this checklist is the
  only guard. Before setting `DOCS_DEPLOY_ENABLED`:
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be deployed, and `release-check`
    (`.github/workflows/release-check.yml`) is green on that `main` commit.
  - Every box in OSS spec §5 is checked — in particular the W0.\* privacy
    scanner, the owner's recorded capability-posture acceptance, and the final
    human manual QA — exactly as required for 9.1.
  - The claims-ledger freeze (`docs/claims-ledger.md`, GATE G1) is re-stamped at
    the actual freeze `main` sha and owner-signed, so the public site cannot
    ship provisional or unsigned public claims.
  - Before removing the access restriction, complete the published-artifact
    acceptance and user-documentation cutover in 9.6 so stable install commands
    cannot become public before their release evidence exists.
  - Complete the staged external demo verification in 9.7 while the docs site
    and its Live Demo CTA remain access-restricted. Removing the docs restriction
    is the CTA publication action and must not precede that verification.
- **Action.** Set the repository variable `DOCS_DEPLOY_ENABLED=true` so the
  `deploy` job in `.github/workflows/docs-site.yml` can run. Manually dispatch
  `Docs Site` at the audited `main` ref; do not wait for an unrelated push.
  Keep the candidate access-restricted until every public-cutover precondition
  above passes, then remove the restriction.
- **Verification.** Confirm the dispatched run SHA equals the gated and frozen
  `main` SHA, the `deploy` job runs rather than skips, and `pnpm docs:build` +
  `pnpm docs:check:runtime` are green on that built artifact. After removing the
  restriction, verify the site from an external non-allowlisted network and
  confirm no Cloudflare Access challenge appears.
- **Rollback.** Re-enable the Cloudflare Access restriction (or otherwise
  disable the public custom domain), then unset `DOCS_DEPLOY_ENABLED` so future
  deploy jobs skip. If a bad build shipped, redeploy the previous
  `docs-site-dist` artifact before reopening access. Unsetting the variable
  alone does not withdraw an already deployed Pages site.

### 9.3 — Repository-rename redirect (owner-only)

- **Action.** After the visibility flip, verify GitHub's
  automatic old-URL redirects resolve and confirm that `REPO_URL` in
  `docs/.vitepress/config.ts` and the README badges point at `ebarti/JobCtrl`.
  Repair any stale target and rerun `pnpm docs:build`.
- **Rollback (for reference).** Rename back (GitHub reserves the prior name);
  revert the `REPO_URL`/link edits.

### 9.4 — Release tagging and publication (owner-only)

- **Preconditions.** Every exact-tree local and hosted gate in 9.1 passes, the
  claims ledger is frozen at that audited `main` SHA, and every protected
  release environment in 9.4a is configured.
- **Action.** Fetch `origin/main` and tags, verify that the audited local commit
  and `origin/main` resolve to the same SHA, then create and push the exact
  `v2.0.0` tag on that commit. Verify the remote tag and `main` still resolve to
  that SHA before dispatch. Re-check that the `jobctrl` PyPI name is still
  available and configure/verify its Trusted Publisher immediately before
  release. A pending publisher can create the project on first publish but does
  **not** reserve the name
  ([PyPI documentation](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)).
  Configure the Trusted Publisher for workflow `release-distribution.yml` and
  environment `pypi`. Dispatch that workflow at `refs/tags/v2.0.0` with
  `release_tag=v2.0.0` and the remaining owner-approved release inputs. After
  immutable GitHub publication, its clean `pypi-resolve` job checks out that
  exact ref without credentials, verifies the tracked finalizer bundle and
  license notice, verifies the immutable Release
  attestation, safely extracts the audit evidence with system Python, and
  validates the signed P6 candidate against the protected public key and key ID
  before any project
  dependency runs. Two independent builders then install only the locked
  `release-build` group (`build` and Hatchling), create fixed-epoch wheel and
  source archives without isolation, and run the strict scanner. A fresh job
  byte-compares both inventories and authors the publication checksum. The
  separate `pypi` job has no checkout, build tools, or release-key inputs: it
  re-resolves the tag and audited `main`, verifies only the compare-sealed
  artifact, and uses OIDC to publish those unchanged bytes. Verify the PyPI
  package and immutable GitHub Release after the workflow succeeds.
- **Rollback.** Preserve the immutable Release and tag as audit evidence. Yank
  a bad PyPI file/version when necessary, then publish a new higher-sequence
  signed release that explicitly revokes or supersedes the affected build.

### 9.4a — Signed distribution environment protections (owner-only)

This step is protection-only. Do not generate, rotate, re-enter, or relocate
release credentials during launch, and do not add a PyPI API token: the PyPI
job publishes through OIDC.

- **Action.** After the visibility flip, require an owner approval on
  `release-signing`, `release-publication`, `release-verification`, and `pypi`.
  Add a deployment policy matching only protected `v*` tags to each of the
  three `release-*` environments, and confirm that `pypi` remains tag-only.
  Do not admit branches. Verify the external PyPI Trusted Publisher mapping
  named in 9.4.
- **Verification.** Read back every environment rule before dispatch: each
  environment requires owner approval and admits only protected `v*` tags.
  Dispatch at `refs/tags/<release_tag>` so `GITHUB_REF` and `GITHUB_SHA` identify
  the same audited tag and commit checked by the resolver. Confirm the jobs
  pause at their intended approvals and that the workflow's fail-closed input
  and trust-anchor checks pass without printing protected values.
- **Rollback.** Cancel the release run if an environment rule or protected
  input check fails. Keep the repository and docs access-restricted, correct the
  protection or external publisher mapping, and rerun from the same audited tag;
  do not weaken an environment rule or move credentials to bypass the failure.

**Hosted-execution stop condition.** After the visibility flip, require every
hosted gate to execute real steps on the exact audited SHA. If GitHub cannot
execute them, stop publication and resolve hosted Actions availability before
proceeding. Keep the repository and docs access-restricted, and do not advertise
curl or Homebrew as stable install paths, until 9.4a and the first live signed
release verification complete.

### 9.5 — Homebrew tap publication (signed-release-gated)

`packaging/homebrew/Formula/jobctrl.rb.tmpl` is the one canonical formula
template in this repository. Before publication, replace any legacy HEAD-only
or source-bootstrap tap formula only through the signed workflow; never treat
it as stable release evidence. The implemented P6 signer job renders the
replacement formula once from the signed stable descriptor and exports its
exact SHA-256. A credential-free job
smoke-tests that formula and published ZIP without re-rendering either. The reusable tap
workflow receives the untouched signed candidate and separate smoke evidence,
re-verifies the signer-rooted formula digest, and seals the exact formula
without tap credentials before handing only the formula and checksum to a
fresh deploy-key job. It never triggers from `main` or merely from a published
GitHub Release.
The formula writes only its Homebrew prefix: its `bin/jobctrl` target is a
native first-invocation bootstrap holding the signed descriptor resources and
cached ZIP. It must not create `~/.jobctrl`, mutate a Cellar payload, or link a
runtime payload from the Cellar during `brew install`.

- **Action.** Configure the external signing/publication gates, then run the
  implemented signed-descriptor, published-ZIP smoke, formula render,
  Ruby syntax, and Homebrew audit/test gates; atomically promote or confirm the
  signer-authored channel pointer; only then call the reusable sync workflow
  with the verified render. Do not edit the tap copy by hand.
- **Rollback.** Revert `Formula/jobctrl.rb` in the tap after coordinating a
  signed release revocation; the source-development instructions are separate.

### 9.6 — Published-artifact acceptance and user-doc cutover (owner-only)

The owning contract is
[`docs/plans/2026-07-10-bundled-jobctrl-distribution-plan.md`](plans/2026-07-10-bundled-jobctrl-distribution-plan.md)
Phase 7 and its Definition of Done.

- **Preconditions.** Steps 9.4 and 9.5 publish the signed release, immutable
  build assets, stable channel pointer, PyPI distributions, and verified tap
  formula. Keep stable install claims access-restricted until this step passes.
- **Action.** Run and record the plan's published-artifact acceptance matrix:
  clean Apple-silicon macOS installs through both curl and Homebrew; no source
  checkout or developer toolchain; fresh and existing JobCtrl state; warm and
  cold provider authentication; core use without authenticated-browser
  capabilities; explicit enable/disable and adoption of those capabilities;
  update, forced failed update, rollback, migration, uninstall, and default data
  preservation; and real-path TTFV evidence for the first scored job and first
  reviewable tailored PDF. Confirm both acquisition paths report the same build
  ID and manifest digest.
- **Action — documentation cutover.** Only after the acceptance matrix passes,
  verify every canonical user surface named by the plan presents the two stable
  acquisition commands followed by one `jobctrl start` surface, removes
  developer tools from user requirements, explains managed versus optional
  browser capabilities, and preserves source-development commands for
  contributors.
- **Verification.** Every item in the plan's Definition of Done passes; release
  evidence records the clean-machine, lifecycle, TTFV, SBOM, license, size,
  signature, checksum, and provenance results; no Blocker/High review or QA
  finding remains. Only then archive the plan and allow curl/Homebrew stable
  advertising; the docs public cutover in 9.2 additionally waits for the staged
  demo verification in 9.7.
- **Rollback.** If any acceptance item fails, withdraw stable install claims,
  keep the docs access-restricted, restore the prior signed channel pointer and
  tap formula when one exists, and revert the user-doc cutover. Preserve the
  immutable failed-release evidence and user data while preparing a new signed
  release that supersedes or revokes it.

### 9.7 — Public live-demo cutover (owner-only)

The owning implementation and privacy contract is
[`docs/plans/2026-07-11-public-live-demo-plan.md`](plans/2026-07-11-public-live-demo-plan.md).
Public cutover must satisfy that plan's Definition of Done.

- **Preconditions.** The exact-tree local gate and all post-public hosted gates
  in 9.1 and the published-artifact gate in 9.6 pass. The owner approves the
  controller identity, privacy contact,
  public privacy/cookie notice, Cloudflare processor/transfer posture, and the
  lawful basis and copy for the acceptance-required consent gate and disclosed
  non-linkable operational counters. The claims ledger is frozen at the release
  SHA. No Blocker/High security, review, or QA finding remains.
- **Action.** On the approved deployment, remove the Cloudflare Access IP
  restriction from `demo.jobctrl.dev` while keeping the docs site and its Live
  Demo CTA access-restricted. Leave `DEMO_DEPLOY_ENABLED=true` only while
  production deployment from audited `main` is intended.
- **Staged verification.** From an external non-allowlisted network and a fresh
  browser profile, direct routes load; only the static consent shell exists
  before a decision; decline redirects to `jobctrl.dev`; confirmed consent
  initializes only the isolated synthetic workspace; irreversible effects
  remain simulated; product-state values never cross the telemetry boundary;
  D1 retention,
  security headers, production smoke, and rollback rehearsal pass. Record the
  exact deployment/SHA evidence required by the demo plan. Only after this
  passes, complete 9.2 to expose the docs site and CTA, then verify the public
  CTA resolves to the already-verified demo.
- **Rollback.** Re-enable the Cloudflare Access restriction first, disable
  `DEMO_DEPLOY_ENABLED`, restore the previous Pages/Worker deployment and D1
  bindings if needed, and withdraw the public CTA. Preserve audit evidence for
  the failed cutover.

## Pending-action summary

| Step | Executor | Pending action |
| --- | --- | --- |
| 9.1 Visibility flip | Owner | Run the exact-tree local gate, flip visibility, then rerun every hosted build gate on the same SHA. |
| 9.2 Docs-site deploy | Owner | Dispatch at the gated `main` SHA, then remove Access only after 9.6 and the staged 9.7 demo verification pass. |
| 9.3 Rename redirect | Owner | Verify old-URL redirects after the flip and repair any stale repository links. |
| 9.4 Release and PyPI | Owner | Create and push `v2.0.0` on audited `main`, verify remote SHA parity, then dispatch and verify the signed release. |
| 9.5 Homebrew tap | Signed workflow | Replace the legacy formula only with the verified render after release-origin smoke passes. |
| 9.6 Published-artifact acceptance | Owner | Run clean-machine, lifecycle, TTFV, and release-evidence gates, then complete the stable user-doc cutover. |
| 9.7 Public live demo | Owner | Approve the privacy/legal boundary, remove demo Access, verify externally while the CTA stays restricted, then expose it through 9.2. |
