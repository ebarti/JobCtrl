# Publish Checklist

> **Repository-only.** Excluded from the published docs site (registered in
> `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` + `srcExclude`, like
> `docs/backlog.md`). It is launch-governance, not user documentation.
>
> Implements Phase C of
> [`docs/plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md`](plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md)
> §9.

## Purpose and boundary

A concrete, verifiable checklist for the pending publication actions, each with
a verification and a rollback note. This checklist **prepares and verifies** the
steps; it does **not** execute them. The cumulative product-redesign acceptance
gate is included because the redesigned application, screenshots, and owning
documentation must be one exact-tree release candidate before publication.

The **authoritative release gate is OSS spec §5**
([`docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md`](plans/implemented/2026-07-03-oss-release-remediation-spec.md)
§5 "Release gate — flipping public"). That gate owns the capability and privacy
preconditions (W0.\* privacy scanner, W1.\* apply safety, W2.\* naming/governance,
Temporal P1b–P5). This checklist does not duplicate those; it lists only the
publish *mechanics* that feed the gate. If GitHub cannot start hosted jobs while
the repository is private, the owner may flip visibility after the complete
exact-tree local gate passes solely to unblock those runs. The launch record has
two linked identities: **R**, the immutable tagged-release source SHA/tree and
artifact evidence; and **D**, the separate post-release installer/docs commit,
deployment SHA, and deployment evidence. It replaces an owner-signed
claims-ledger freeze or any committee-style sign-off as a launch requirement.
Release tagging, Homebrew stable publication, and PyPI publication remain
prohibited until the applicable hosted gates execute and pass.

## Owner-only actions (do not execute here)

Every state-changing step below is an **owner-only** action. Implementing agents
prepare and run read-only verification; the repository owner executes. The
remaining actions are governed by the release gate plus the active bundled
distribution, public-demo, and end-to-end redesign plans.

## Current operational state (recheck at execution time)

This is the **last validated snapshot**, not release evidence. At 2026-07-21,
`origin/main` was private at `61a3de9d1952ecd75a3f7e7781b20667512718ff`
(tree `5212c73d90e9c786d9f13c75c6a582ba4b3ef05b`), with no open pull requests
and no GitHub Releases. More preparation PRs are expected, so this is not a
final release candidate. The release coordinator must refresh `origin/main`,
record its final validated SHA and tree, and confirm the exact candidate as the
final pre-commit/pre-tag coordinator step; do not reuse this snapshot as its
proof.

- The docs and demo are already publicly served by Cloudflare and return HTTP
  200. `DOCS_DEPLOY_ENABLED=true` and `DEMO_DEPLOY_ENABLED=true` are already
  set. Neither site needs an Access change or a visibility cutover.
- Hosted Actions currently fail before job steps because of the private
  repository's account state. Do not buy, enable, or otherwise treat hosted
  execution as a pre-public billing task. After the repository is public,
  manually rerun the standard hosted workflows on the audited SHA and require
  actual executed steps.
- The signing, Apple Developer ID/notary, R2, and Homebrew environment
  credential names are configured, as are the release public-key variables.
  The PyPI Trusted Publisher is configured and `pypi` already has a `v*` tag
  policy. Never print credential values in this checklist or its evidence.
- `release-signing`, `release-publication`, and `release-verification` have no
  deployment protections yet. After the visibility flip, each must require the
  owner and admit only protected `v*` tags. The live stable R2 pointer is 404,
  `jobctrl.dev/install.sh` has intentionally empty pins and fails closed, and
  the Homebrew tap is still a legacy HEAD/source formula. These are expected
  first-release states, not stable-install evidence.
- After the controller-disclosure PR lands, verify the controller and privacy
  contact in the canonical [Public demo disclosure](user/data-and-safety.md#public-demo).
  That page is the sole public source of those factual contact statements; it is
  not legal advice or a statement about legal obligations in every jurisdiction.

## Required sequence

1. Assemble the complete Rhea/Base UI stack, including the cumulative browser
   annotation fixes.
2. Finish canonical documentation and regenerate the synthetic product
   screenshots on that assembled tree.
3. Record the resulting integration-tip SHA and tree. Only then run the cumulative
   static, route-workspace, browser, visual, accessibility, reviewer, and QA
   gates in 9.0.
4. Fix any finding on the integration tip, update affected docs or screenshots,
   record a new SHA and tree, and rerun the invalidated gate. Do not carry
   evidence from an older tree forward.
5. After merge, prove the audited `main` tree is byte-for-byte the frozen
   integration tree. If merge or rebase changes content, rerun the invalidated
   9.0 gates. Continue with visibility, hosted exact-SHA gates, signed
   publication, installer cutover, published-artifact acceptance, and public
   smoke in the order below.

## Steps

### 9.0 — Cumulative Rhea/Base UI redesign acceptance

The owning contract is
[`docs/plans/2026-07-14-end-to-end-product-redesign.md`](plans/2026-07-14-end-to-end-product-redesign.md),
especially §§11–14. This is a release precondition, not permission to publish.

- **Documentation and screenshot freeze.** Complete every owning user,
  architecture, API, requirements, decision, and QA document before starting
  the cumulative QA run. Regenerate screenshots only through the seeded
  Playwright harness, inspect every changed image at its intended viewport, and
  ensure the product tour describes the rendered application:

  ```bash
  corepack pnpm docs:screenshots
  corepack pnpm docs:build
  corepack pnpm docs:check:runtime
  ```

  Commit the resulting docs and images into the integration tip before the
  cumulative gate. A later product, fixture, screenshot, or owning-doc change
  invalidates the affected evidence and requires a new exact-tree run.
- **Static, component, and contract gate.** Run the commands in the redesign
  plan §12.1 and the
  [Cumulative Rhea/Base UI Final Gate](local-reliability-qa.md#cumulative-rheabase-ui-final-gate).
  At minimum this includes the full repository checks, web unit/type/build and
  Storybook gates, the focused API/Python integration tests, and diff hygiene.
- **Base UI/shadcn boundary.** Preserve shadcn-owned composition and styling in
  `apps/web/src/shared/ui/`; Base UI supplies accessible behavior underneath
  those wrappers. The boundary gate must find no direct `@radix-ui/*` imports,
  no raw native selects, and no route/context code bypassing the shared
  wrappers. Prove keyboard navigation, accessible names, focus containment and
  return, Escape/outside dismissal, controlled state, and portal stacking on a
  real route, not only from component classes.
- **Route-workspace gate.** Run the focused workspace regressions before the
  browser sweep:

  ```bash
  corepack pnpm --filter @jobctrl/web exec vitest run \
    'src/routes/-jobs.$jobId.run.$runId.test.tsx' \
    src/views/jobs/JobDetailDrawer.test.tsx \
    src/views/artifacts/ArtifactDetailPanel.test.tsx \
    src/views/outreach/OutreachDetailDrawer.test.tsx \
    src/views/runs/WorkflowRunDrawer.test.tsx \
    src/views/debug/ActivityDetailDrawer.test.tsx
  ```

  Job, job-run, artifact, contact, workflow-run, and activity details must be
  complete route workspaces with their facts, actions, history, provenance,
  warnings, and failure evidence still reachable. A legacy `*Drawer` filename
  is not permission to render a transient drawer.
- **Browser and visual gate.** Run the complete web E2E suite, the seeded route
  visual gate, and the
  [cumulative route sweep](developer/qa/browser-smoke.md#cumulative-redesign-route-sweep):

  ```bash
  corepack pnpm --filter @jobctrl/web e2e
  JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-route-qa \
  JOBCTRL_E2E_API_PORT=8878 \
  JOBCTRL_E2E_WEB_PORT=5275 \
  corepack pnpm --filter @jobctrl/web e2e -- tests/route-visual-qa.spec.ts
  ```

  Verify every production route and detail route in light/dark and
  compact/regular/comfortable density at 1440px, 1280px, collapsed-rail, and
  390×844. Record route, state, viewport, theme, density, console result, and
  interaction result. Compare the production-shaped states to the approved
  prototype frames while treating current code/contracts as the authority for
  every field, action, warning, unavailable state, and audit record.
- **Synthetic-only safety.** Screenshot, browser, visual, credential-state,
  materials, and workflow QA must use seeded or disposable workspaces, stubbed
  dispatchers, and synthetic fixtures. Do not submit an application, scan a
  real mailbox, use real profile/contact/job data, expose or modify real
  credentials, spend against a live model, invoke worker-backed work merely for
  visual proof, or mutate a real JobCtrl database/browser profile.
- **Independent gates.** `pr-reviewer` and `qa` must each return `Gate: PASS`
  with no Blocker or High finding on the frozen SHA. Resolve or explicitly list
  remaining Medium/Low observations in the final PR body.
- **Verification.** Record the frozen SHA and exact command results. Confirm
  the `base-rhea` token/type/radius/card/status contract, route-workspace parity,
  generated screenshots, docs build/runtime checks, complete route sweep,
  accessibility behavior, truthful pipeline operations, credential ownership,
  browser-capability adoption, and retry-readiness preservation all pass on
  that same tree.
- **Rollback.** Do not publish. Fix the owning layer, update any affected docs
  and screenshots first, freeze a new SHA, and rerun the invalidated gate. Never
  hide a failed parity, accessibility, safety, or auditability result with a
  cosmetic exception.

### 9.1 — Repository visibility flip (owner-only)

- **Preconditions.** The complete 9.0 gate passes on the frozen integration
  tree, the merged `main` tree is identical, and every release-gate prerequisite
  below is satisfied. Record the audited `main` SHA **and tree hash**, complete
  local QA results, and the intended deploy ref in one release record before
  changing visibility.
- **Action.** Owner flips `github.com/ebarti/JobCtrl` from private to public.
- **Verification.**
  - Before the flip, run the complete local matrix on the exact `main` tree,
    including strict release/privacy scanning and built-distribution scanning.
  - Immediately after the flip, rerun Release Privacy Gate, Docs Site, Demo
    Site, Native Launcher CI, Python CI, and TypeScript CI on that exact `main`
    SHA. `Sync Homebrew Tap` is reusable only from the later signed-release
    workflow; it is not a standalone post-flip build gate. A run with zero
    executed steps is not passing evidence. The current private-repository
    account failure is expected to occur before steps; rerunning on a public
    repository is the hosted-execution proof, not a pre-public billing action.
    If Release Privacy Gate fails after actually executing, return the repository
    to private while investigating. Any other hosted failure blocks tagging and
    publication.
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

### 9.2 — Docs-site deployment verification (owner-only)

- **Current state.** The docs site is already public through Cloudflare and
  `DOCS_DEPLOY_ENABLED=true` is set. This is a deployment-verification step,
  not an Access or public-visibility cutover. The `deploy` job in
  `docs-site.yml` is gated only on `DOCS_DEPLOY_ENABLED` and `main` — **not**
  on `release-check` — so this checklist remains its release guard.
- **Preconditions.** The 9.0 gate and the matching local release/privacy checks
  pass on the recorded SHA and tree. Before dispatch:
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be deployed, and `release-check`
    (`.github/workflows/release-check.yml`) is green on that `main` commit.
  - Every box in OSS spec §5 is checked — in particular the W0.\* privacy
    scanner, the owner's recorded capability-posture acceptance, and the final
    human manual QA — exactly as required for 9.1.
  - The release record names the same SHA and tree used by 9.1. Stable install
    wording remains provisional until the post-release installer cutover and
    public smoke in 9.6 pass.
- **Action.** Manually dispatch `Docs Site` at the audited `main` ref; do not
  toggle the already-enabled variable or wait for an unrelated push.
- **Verification.** Confirm the dispatched run SHA equals the gated and frozen
  `main` SHA, the `deploy` job runs rather than skips, and `pnpm docs:build` +
  `pnpm docs:check:runtime` are green on that built artifact. Record this
  deployment SHA separately from the immutable release/tag SHA when the later
  post-release installer/docs cutover in 9.6 changes `main`.
- **Rollback.** Redeploy the previous known-good `docs-site-dist` artifact or a
  corrective audited commit. Do not represent a reverted deployment as stable
  release evidence.

### 9.3 — Repository-rename redirect (owner-only)

- **Action.** After the visibility flip, verify GitHub's
  automatic old-URL redirects resolve and confirm that `REPO_URL` in
  `docs/.vitepress/config.ts` and the README badges point at `ebarti/JobCtrl`.
  Repair any stale target and rerun `pnpm docs:build`.
- **Rollback (for reference).** Rename back (GitHub reserves the prior name);
  revert the `REPO_URL`/link edits.

### 9.4 — Release tagging and publication (owner-only)

- **Preconditions.** The 9.0 redesign gate and every exact-tree local and hosted
  gate in 9.1 pass, the release record contains that audited `main` SHA and tree
  plus its QA/deploy evidence, and every protected release environment in 9.4a
  is configured. The PyPI Trusted Publisher is already configured; verify its
  mapping rather than creating a second publisher or using a PyPI API token.
- **Recovery note.** Preserve the failed `v2.0.0`, `v2.0.1`, `v2.0.4`,
  `v2.0.5`, and `v2.0.6` tags, the unpublished `v2.0.2` tag, and the partially
  published `v2.0.3` tag at their original commits as audit evidence.
  `v2.0.0` stopped before signing because
  the signing runner requested an unavailable Python build. `v2.0.1` completed
  its builds, signing, Apple notarization, stapling, and audit packaging, then
  stopped before GitHub draft creation or R2 upload because a checkout-free
  publication job did not bind GitHub CLI to the repository. Do not move,
  delete, or dispatch any of those tags again. `v2.0.2` was tagged after the
  publication fix merged, but no release workflow was started for it.
  `v2.0.3` completed signing, Apple notarization, stapling, audit packaging,
  draft creation, and immutable R2 upload. It did not promote the stable
  pointer or publish the GitHub Release, Homebrew formula, or PyPI package
  because the current Homebrew CLI rejects auditing a formula by file path.
  Its immutable objects and draft are recovery evidence, not a stable release.
  `v2.0.4` passed identity, preflight, and the single candidate build, then
  stopped before signing when another merged PR advanced `main` during the
  candidate handoff. The tag and candidate stayed exact; the obsolete live-head
  equality check caused the failure. Nothing was signed or published.
  `v2.0.5` completed its build, signing, Apple notarization, stapling, and audit
  packaging, then uploaded its immutable archive to R2. Its public readback
  failed because the workflow's pre-upload 404 remained cached longer than the
  post-upload verification window; the GitHub Release, stable pointer,
  Homebrew formula, and PyPI package were not published.
  `v2.0.6` completed its build, signing, Apple notarization, stapling, audit
  packaging, immutable R2 publication, and native installer lifecycle smoke.
  Its strict Homebrew formula audit found new style violations before formula
  installation, so the stable pointer, public GitHub Release, Homebrew tap, and
  PyPI package were not published.
  Do not move, delete, or dispatch any of these tags again.
- **Action.** Fetch `origin/main` and tags, verify that the audited local commit
  and `origin/main` resolve to the same SHA, then create and push the exact
  `v2.0.7` tag on that commit. Verify the remote tag resolves to that exact SHA
  and the tagged commit remains identical to or an ancestor of current `main`.
  Pushing this exact tag starts `Release distribution` with these
  first-release defaults; the manual dispatch path remains available:

  ```text
  release_tag=v2.0.7
  channel=stable
  sequence=1
  minimum_safe_sequence=1
  revoked_build_ids=[]
  expected_channel_pointer_sha256=absent
  ```

  The final `absent` value is required because the live stable pointer currently
  returns 404; it is the workflow's explicit conditional-create precondition.
  After immutable GitHub publication, the credential-free `pypi-resolve` job
  verifies the exact ref, release attestation, audit evidence, and public trust
  before the single clean PyPI builder produces checksum-bound distributions.
  The `pypi` job then publishes only those unchanged bytes through OIDC. Verify
  the PyPI package and immutable GitHub Release after the workflow succeeds.
- **Rollback.** Preserve the immutable Release and tag as audit evidence. Yank
  a bad PyPI file/version when necessary, then publish a new higher-sequence
  signed release that explicitly revokes or supersedes the affected build.

### 9.4a — Signed distribution environment protections (owner-only)

This step is protection-only. Do not generate, rotate, re-enter, or relocate
release credentials during launch, and do not add a PyPI API token: the PyPI
job publishes through OIDC. The tracked `blocked-awaiting-credentials` and
`unprovisioned` signing-policy values are fail-closed workflow posture, not
evidence that a live environment secret or variable is absent.

- **Action.** Read the live repository and environment-scoped secret/variable
  inventories by name without reading or printing values. If a workflow input
  is genuinely missing, stop and coordinate its provisioning outside this
  checklist; do not embed key-generation or clipboard commands here. After the
  visibility flip, require the owner and add a deployment policy matching only
  protected `v*` tags to `release-signing`, `release-publication`, and
  `release-verification`. Do not admit branches. `pypi` already has its `v*`
  tag policy; verify that policy and its external Trusted Publisher mapping
  named in 9.4 rather than replacing them.
- **Verification.** Read back every environment rule before dispatch: each
  `release-*` environment requires owner approval and admits only protected
  `v*` tags, while `pypi` retains its tag-only policy. Dispatch at
  `refs/tags/<release_tag>` so `GITHUB_REF` and `GITHUB_SHA` identify the same
  audited tag and commit checked by the resolver. Confirm the jobs pause at
  their intended approvals and that the workflow's fail-closed input and
  trust-anchor checks pass without printing protected values.
- **Rollback.** Cancel the release run if an environment rule or protected
  input check fails. Correct the protection or external publisher mapping, and
  rerun from the same audited tag; do not weaken an environment rule or move
  credentials to bypass the failure.

**Hosted-execution stop condition.** After the visibility flip, require every
hosted gate to execute real steps on the exact audited SHA. If GitHub cannot
execute them, stop publication and resolve hosted Actions availability before
proceeding. Do not advertise curl or Homebrew as stable install paths until 9.4a
and the first live signed-release verification complete.

### 9.5 — Homebrew tap publication (signed-release-gated)

`packaging/homebrew/Formula/jobctrl.rb.tmpl` is the one canonical formula
template in this repository. Before publication, replace any legacy HEAD-only
or source-bootstrap tap formula only through the signed workflow; never treat
it as stable release evidence. The implemented P6 signer job renders the
replacement formula once from the signed stable descriptor and exports its
exact SHA-256. A credential-free job smoke-tests that formula and published ZIP
without re-rendering either. The reusable tap workflow receives the untouched
signed candidate and separate smoke evidence,
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
  formula. Before the first release, `jobctrl.dev/install.sh` intentionally has
  empty pins and fails closed; the legacy tap is HEAD/source only. Neither is a
  stable acquisition path until the signed release has cut them over.
- **Pinned-renderer regression gate.** Before copying any retrieved pinned bytes
  into `scripts/get` or `docs/public/install.sh`, merge the Tier 3
  `renderPinnedInstallScript` regression fix. Its contract must replace an
  existing release's URL, SHA-256, and version pins with the next release's
  values, not only replace empty pins; its regression coverage must prove a
  `v2.0.7` render cannot retain `v2.0.6` pins. Do not use a manually edited
  installer as a workaround.
- **Action.** Run and record the plan's published-artifact acceptance matrix:
  clean Apple-silicon macOS installs through both curl and Homebrew; no source
  checkout or developer toolchain; fresh and existing JobCtrl state; warm and
  cold provider authentication; core use without authenticated-browser
  capabilities; explicit enable/disable and adoption of those capabilities;
  update, forced failed update, rollback, migration, uninstall, and default data
  preservation; and real-path TTFV evidence for the first scored job and first
  reviewable tailored PDF. Confirm both acquisition paths report the same build
  ID and manifest digest.
- **Mandatory canonical-installer cutover.** Treat the immutable signed release
  and the public installer deployment as two linked but different records:

  1. Record the immutable `v2.0.7` tag/release SHA and tree as **R**. Retrieve
     that release's immutable pinned `install.sh` and `SHA256SUMS`, verify
     `install.sh` against its published SHA-256, and retain the verified asset
     URL and checksum with R. Do not reconstruct or edit the retrieved script.
  2. Create a separate post-release installer/docs commit and PR containing the
     same verified bytes in **both** `scripts/get` and
     `docs/public/install.sh`. This is the required canonical-installer cutover;
     it must not amend the immutable tag or release assets. Run
     `node scripts/get.test.mjs`, `node scripts/check-install-asset.mjs`,
     `python3 scripts/release_check.py --strict-prompt`,
     `corepack pnpm docs:build`, and `corepack pnpm docs:check:runtime` on the
     PR head. Merge it, dispatch/deploy Docs Site, and record the post-release
     installer/docs deployment SHA and Cloudflare deployment ID as **D**.
  3. Confirm that D is the deployed public `https://jobctrl.dev/install.sh`,
     contains the verified pins for R's immutable artifacts, and no longer
     follows the intentional empty-pin fail-closed path. R is release evidence;
     D is installer/docs deployment evidence. Never claim they are one SHA.
- **Public command smoke.** Only after D is public, use clean Apple-silicon
  macOS environments on the public network to run the canonical curl installer
  and `brew install ebarti/tap/jobctrl`, then verify `jobctrl --version`,
  `jobctrl doctor`, and `jobctrl start --no-open`. Record R, D, the release tag,
  build ID, manifest digest, pointer digest, command results, and matching
  GitHub Release/PyPI artifact URLs. Do not substitute a source checkout, a
  local installer file, or the legacy tap for this proof.
- **Action — documentation cutover.** In the post-release installer/docs PR,
  verify every canonical user surface named by the plan presents the two stable
  acquisition commands followed by one `jobctrl start` surface, removes
  developer tools from user requirements, explains managed versus optional
  browser capabilities, and preserves source-development commands for
  contributors.
- **Verification.** Every item in the plan's Definition of Done passes; release
  evidence records the clean-machine, lifecycle, TTFV, SBOM, license, size,
  signature, checksum, and provenance results; no Blocker/High review or QA
  finding remains. The release record contains R; the installer/docs release
  record contains D. Only then allow curl/Homebrew stable advertising and
  proceed to the publicization sequence in section 10.
- **Rollback.** If any acceptance item fails, withdraw stable install claims,
  restore the prior signed channel pointer and tap formula when one exists, and
  revert the user-doc/installer cutover. Preserve the immutable failed-release
  evidence and user data while preparing a new signed release that supersedes
  or revokes it.

### 9.7 — Public live-demo deployment verification (owner-only)

The owning implementation and privacy contract is
[`docs/plans/2026-07-11-public-live-demo-plan.md`](plans/2026-07-11-public-live-demo-plan.md).
The demo is already public; this is release-time deployment and privacy
verification, not a visibility cutover.

- **Preconditions.** The exact-tree local gate and all post-public hosted gates
  in 9.1 and the published-artifact gate in 9.6 pass. After the controller-
  disclosure PR lands, verify the controller and privacy contact in the
  canonical [Public demo disclosure](user/data-and-safety.md#public-demo).
  Confirm the published privacy/cookie copy and Cloudflare processor/transfer
  posture are accurate for the deployment; this records product facts and is
  not legal advice. No Blocker/High security, review, or QA finding remains.
- **Action.** Keep `DEMO_DEPLOY_ENABLED=true`, deploy or verify the approved
  audited `main` ref, and record the Cloudflare deployment identifier with the
  release SHA and tree. Do not perform an Access change.
- **Verification.** From a public network and a fresh browser profile, confirm
  that `demo.jobctrl.dev` remains reachable (HTTP 200), direct routes load, and
  only the static consent shell exists before a decision. Confirm decline
  redirects to `jobctrl.dev`; confirmed consent initializes only the isolated
  synthetic workspace; irreversible effects remain simulated; product-state
  values never cross the telemetry boundary; and D1 retention, security
  headers, production smoke, and rollback rehearsal pass. Record the exact
  deployment/SHA evidence required by the demo plan and verify the docs CTA
  reaches the same public demo.
- **Rollback.** Restore the previous known-good Cloudflare deployment and D1
  bindings if needed, withdraw incorrect public copy, and preserve the failed
  deployment evidence. Do not claim the failed deployment was release-verified.

## 10 — Publicization

Section 10.1 prepares launch material before a release exists. External
publicization begins only after section 9 records the successful immutable
release/tag SHA and tree (R), the separate installer/docs deployment SHA (D),
and public installation proof. It links their workflow runs, deployment
identifiers, and command-smoke evidence; it does not create a second approval
or claims-freeze process.

### 10.1 — Today: prepare assets, copy, and platform access

These tasks are completable before a release exists. Do not invent R/D values:
use explicit placeholders and leave release-specific URLs blank until 10.2.

- [ ] Create the release fact-sheet and destination/measurement-tracker
  templates with placeholders for R, D, immutable release URL, installer, PyPI,
  Homebrew, and platform metrics. Include repository, docs, demo, supported
  platform, canonical curl/Homebrew command slots, and a reference to the
  [Public demo disclosure](user/data-and-safety.md#public-demo).
- [ ] Product Hunt: select and record the intended launch date, time, and time
  zone; prepare human-written placeholders for the exact `name`, `tagline`,
  `short description`, `topics`, `website`, `maker profile`, `gallery assets`,
  and `first-comment plan` fields. Keep the final destination URL blank.
- [ ] Select the exact Product Hunt gallery, thumbnail/logo, screenshot, and
  video assets. Record each file's source path or immutable URL, media type,
  pixel dimensions, and alt/caption ownership; confirm it is synthetic or
  cleared for publication and contains no profile, application, credential,
  tracking, or local-path data.
- [ ] Create direct-link and UTM placeholders for repository, documentation,
  demo, immutable GitHub Release, installer, PyPI, and Homebrew. The tracker
  records source, medium, campaign, final URL, and owner-visible measurement;
  leave final URLs blank until 10.2.
- [ ] Show HN: the owner prepares a human-authored title outline, fact outline,
  and destination placeholder. Record facts and outline only, not paste-ready
  prose, and do not add AI-generated Show HN or Reddit comments to this
  repository.
- [ ] Community eligibility: for every candidate Reddit/community post, record
  the community, canonical rule URL, self-promotion/affiliation requirement,
  moderator decision if required, and a go/no-go decision. If any rule is
  unclear or disallows the post, mark it no-go and do not publish there.
- [ ] LinkedIn and X: select the exact human-authored asset and direct
  destination placeholder for each platform; record the planned publishing
  account, affiliation disclosure, and the corresponding measurement-tracker
  entry.
- [ ] Schedule first-eight-hour response coverage blocks for the responsible
  individual: 0–1h, 1–2h, 2–4h, and 4–8h. Assign coverage for Product Hunt,
  Show HN, GitHub issues/discussions, LinkedIn, X, and every eligible community.
- [ ] Prepare the section 10.5 baseline-capture worksheet for execution
  immediately before the visibility flip, including public endpoint status and
  all available repository/platform counts.
- [ ] Use the separate private launch-response playbook for owner notes if
  needed; do not copy it, its private links, or paste-ready AI-generated Show
  HN or Reddit comments into this repository.

### 10.2 — Launch day: finalize only after R and D

Complete these tasks only after the signed release record R and the deployed
installer/docs record D pass 9.6. Recheck every factual claim against those
records before publishing.

- [ ] Populate the fact sheet with R, D, the immutable release/tag URL,
  installer/docs deployment URL, exact supported platform, canonical commands,
  and the controller/privacy contact verified in the
  [Public demo disclosure](user/data-and-safety.md#public-demo).
- [ ] Replace every destination/UTM placeholder with the verified direct link;
  run the direct-link control and record the final source, medium, campaign,
  destination, and available measurement.
- [ ] Finalize the human-written Product Hunt fields against the live form;
  validate the short description is at most 260 Unicode characters and verify
  its final destination resolves to D's installer or the immutable release.
- [ ] Finalize the owner-written Show HN title, fact outline, and one verified
  destination URL. Do not turn the outline into paste-ready AI-generated text.
- [ ] Finalize the LinkedIn and X human-authored assets, direct destinations,
  affiliation disclosures, and measurement-tracker entries. Reconfirm every
  community's recorded go/no-go decision before posting.

### 10.3 — Launch-day order

Perform the following in order and stop at the first failed gate:

1. Capture the section 10.5 live baseline, then make `ebarti/JobCtrl` public
   after the exact-tree local gate passes.
2. Rerun the standard hosted workflows on the recorded SHA and require green
   runs with executed steps.
3. On that final validated `main` SHA, create and push `v2.0.7`, verify the
   remote tag resolves to that exact SHA and remains in `origin/main` history,
   and confirm the exact
   tag-triggered `Release distribution` run uses the six first-release defaults
   in 9.4. Complete the signed release, channel-pointer promotion, PyPI
   publication, Homebrew formula sync, and immutable release evidence as R.
4. Complete the separate post-release installer/docs PR in 9.6, merge it, and
   deploy Docs Site as D. Verify its public installer bytes still match R's
   immutable pinned `install.sh` before proceeding.
5. Run and record the public command smoke for the curl installer, Homebrew,
   `jobctrl doctor`, and `jobctrl start --no-open`; verify public docs and demo
   endpoints at D's recorded deployment.
6. Complete the R/D-dependent finalization in 10.2, then publish the factual
   launch announcement in this order: Product Hunt, Show
   HN, LinkedIn, X, then only the Reddit communities whose rules explicitly
   allow the post. Do not publish an announcement that points to an installer
   or release that failed the preceding smoke.

### 10.4 — Conduct and response coverage

- Do not buy, trade, coordinate, or solicit votes, reviews, engagement rings,
  or reciprocal promotion. Do not use sockpuppets, repetitive cross-posts,
  automated comments, undisclosed affiliate/employee personas, or direct
  messages that pressure recipients to engage.
- Respect each platform's self-promotion and subreddit rules. If a rule is
  unclear, do not post there. Answer questions in the original thread with
  factual, human-authored replies; correct errors transparently and move
  account, security, or personal-data reports to an appropriate private channel.
- The individual named in the deployed [Public demo disclosure](user/data-and-safety.md#public-demo)
  covers Product Hunt, Show HN, GitHub issues/discussions, LinkedIn, X, and each
  permitted Reddit thread during the first 24 hours; acknowledge material
  questions promptly, log reproducible defects, and do not promise dates or
  outcomes that are not recorded in the roadmap. The controller statement and
  privacy contact remain factual communication details, not legal advice.

### 10.5 — Metrics and closeout

Capture a small time-series without optimizing for vanity metrics. Use only
aggregates that are available to the owner and do not add user-level tracking
for the launch.

| When | Record |
| --- | --- |
| Baseline, before visibility flip | Repository stars/forks/watchers and traffic if available; docs/demo HTTP status; current release/pointer/install/tap state; open issues; platform-account starting counts. |
| 1 hour | Hosted-run and release status; installer/Homebrew command-smoke result; docs/demo availability; announcement publication URLs; early installation failures, safety reports, and questions. |
| 8 hours | The same availability and installation signals; GitHub traffic and issue/discussion volume; platform responses and rule/moderation outcomes; top reproducible feedback. |
| 24 hours | Cumulative repository and platform metrics; release/download data where available; support-response coverage; defects triaged or fixed; any correction or rollback taken. |
| 72 hours | Trend versus baseline; confirmed acquisition-path failures; support and moderation backlog; prioritized follow-up issues and a decision to continue, correct, or pause promotion. |

Close out by attaching the final release record, deployment IDs, public command
smoke, announcement URLs, metrics snapshot, incidents, and follow-up issue links
to the launch record. Remove obsolete drafts, preserve immutable release and
rollback evidence, and publish corrections where a public claim proved wrong.

## Pending-action summary

| Step | Executor | Pending action |
| --- | --- | --- |
| 9.0 Rhea/Base UI acceptance | Implementers + reviewer + QA | Finish docs and synthetic screenshots, record the integration SHA/tree, then pass static, workspace, browser, visual, accessibility, review, and QA gates on that tree. |
| 9.1 Visibility flip | Owner | Run the exact-tree local gate, make the repository public, then rerun every standard hosted gate with real executed steps. |
| 9.2 Docs-site verification | Owner | Docs are already public and deploy is enabled; dispatch at the gated `main` SHA and record the public deployment proof. |
| 9.3 Rename redirect | Owner | Verify old-URL redirects after the flip and repair any stale repository links. |
| 9.4 Release and PyPI | Owner | Preserve failed `v2.0.0`, `v2.0.1`, `v2.0.4`, `v2.0.5`, and `v2.0.6`, unpublished `v2.0.2`, and partial `v2.0.3`; create `v2.0.7` on audited `main`, then verify the exact tag-triggered run uses the recorded first-release defaults and completes the signed release. |
| 9.5 Homebrew tap | Signed workflow | Replace the legacy formula only with the verified signed render after release-origin smoke passes. |
| 9.6 Installer and artifact acceptance | Owner | Verify immutable `install.sh` from R, land matching `scripts/get` and `docs/public/install.sh` in a separate post-release PR, validate/deploy D, then run public curl/Homebrew smoke. |
| 9.7 Public live demo | Owner | The demo is already public and deploy is enabled; verify the audited deployment externally and record its release evidence. |
| 10 Publicization | Owner | Prepare factual assets and platform access today; on launch day announce only after the public release and command smoke pass, then cover responses and record the 1h–72h metrics. |
