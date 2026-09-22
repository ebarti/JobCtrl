# Publish Checklist

> **Repository-only.** Excluded from the published docs site (registered in
> `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` + `srcExclude`). It is
> launch-governance, not user documentation.
>
> Implements Phase C of
> [`docs/plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md`](plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md)
> §9.

## Purpose and boundary

**JobCtrl is publicly launched and published.** GitHub releases `v0.1.0`
(2026-08-12) and `v0.1.1` (2026-08-25) already exist. The
[latest release](https://github.com/ebarti/JobCtrl/releases/latest) and its
signed acquisition channels identify what users can install. Pending releases,
historical first-launch steps, and incomplete P7 acceptance do not change that
publication status. Treat migration and rollback compatibility as obligations
to existing users. The dated reconciliation below separates published evidence
from the remaining verification work.

A concrete, verifiable checklist and historical record for publication actions,
each with verification and rollback guidance. This checklist does **not** by
itself authorize or execute a publication. Completed first-publication steps
remain here as audit history; current state and future-release requirements are
identified explicitly. The cumulative product-redesign acceptance gate is
included because the application, screenshots, and owning documentation must be
one exact-tree release candidate before publication.

The **authoritative release gate is OSS spec §5**
([`docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md`](plans/implemented/2026-07-03-oss-release-remediation-spec.md)
§5 "Release gate — flipping public"). That gate owns the capability and privacy
preconditions (W0.\* privacy scanner, W1.\* apply safety, W2.\* naming/governance,
Temporal P1b–P5). This checklist does not duplicate those; it lists only the
publish *mechanics* that feed the gate. The repository visibility transition is
complete and retained in 9.1 as historical evidence; future releases require
hosted jobs to execute on the audited public ref. The launch record has two
linked identities: **R**, the immutable tagged-release source SHA/tree and
artifact evidence; and **D**, the separate post-release installer/docs commit,
deployment SHA, and deployment evidence. It replaces an owner-signed
claims-ledger freeze or any committee-style sign-off as a launch requirement.
Release tagging, Homebrew stable publication, and PyPI publication remain
prohibited until the applicable hosted gates execute and pass.

## Verification boundaries for subsequent releases

The prepared payload is checked against its manifest before credentials are
loaded and again immediately before signing. The unsigned archive keeps its
transport digest and size check, but the verifier does not rebuild it or perform
a second bytewise comparison: the signing path consumes the verified payload
and produces new notarization and distribution archives. ZIP reproducibility is
covered by the packager tests.

GitHub draft creation/reuse and final publication compare each asset's
service-reported SHA-256 digest with the local signed candidate. Missing,
duplicate or mismatched asset identities fail before publication; the workflow
does not download the same large draft assets again solely to compare bytes.
After publication it still verifies GitHub's immutable release and asset
attestations. Public installer downloads, descriptor/manifest signatures, native
and Homebrew lifecycle tests, and atomic channel promotion remain required.

## Owner-only publication actions and records

Every state-changing step below is an **owner-only** action. Implementing agents
prepare and run read-only verification; the repository owner executes. Completed
steps are historical records rather than instructions to repeat them. Remaining
actions are governed by the release gate plus the active bundled-distribution,
public-demo, and end-to-end redesign plans.

## Published-byte reconciliation — 2026-09-22

This bounded investigation for [#884](https://github.com/ebarti/JobCtrl/issues/884)
rechecked public release bytes and existing evidence before selecting missing
checks. **Full P7 acceptance remains unverified.** Publication, an unsigned
build, source tests, and a successful native smoke are distinct evidence.
Observations below were made on 2026-09-22 at approximately 12:50–12:55 UTC;
mutable channels and workflow states must be rechecked before reuse.

### Immutable release and acquisition identities

The latest published GitHub release is still
[`v0.1.1`](https://github.com/ebarti/JobCtrl/releases/tag/v0.1.1)
(release ID `376278118`, API `immutable: true`, published
`2026-08-25T17:54:39Z`). Its source commit is
`726ca08bd893bba2b932cd6b66835a0bf6d56f7f`, tree
`3cfb19af2d031fed0b565692e3750977ff478099`, and build ID is
`0.1.1-726ca08bd893bba2b932cd6b66835a0bf6d56f7f-darwin-arm64`.

| Object | Observed SHA-256 / policy |
| --- | --- |
| [Stable pointer](https://releases.jobctrl.dev/v1/stable/darwin-arm64.json), also byte-identical to the release's immutable `channel-pointer.json` | `84319ad4a488d577414a796072057501ed68c9328627a0d716d90867368d31bb` |
| [Release descriptor](https://github.com/ebarti/JobCtrl/releases/download/v0.1.1/release-descriptor.json), matching its R2 object | `78b1bb105b4a1022c7e0210552732ffeb6327d5b77cccf79f4893df72f973f9c` |
| Descriptor signature, matching GitHub and R2 | `de3ce729962fed0047c0deeb9d0a33897dd2555d55bdc86eeda1ec508e6e79af` |
| [Manifest](https://github.com/ebarti/JobCtrl/releases/download/v0.1.1/manifest.json) | `3c79d79a3d218d51a934b6de79c7a3a2df9ade3d54e1c5cffe703d6ee891649b` |
| Manifest signature | `4c0fb632ce42ec974feec37fac51bfd6b4ddd287c3ad172990d16a1e2a5ed0e8` |
| Published ZIP, 357,720,868 bytes | `30745567c8f28852f077079d7bd3135b966fd0ef4477b256e324798e31810a3e` |
| Signed descriptor policy | Stable sequence **4**, minimum-safe sequence **2** |
| Revoked build IDs | `2.0.7-db257efe1087ec00ac2ec49b846a95d2423aecc2-darwin-arm64` only |

Independent verification used `verifyReleaseBytes` from
`scripts/distribution-release.mjs` for both Ed25519 signatures against the
configured `release-verification` environment's **public** trust key. The key
text SHA-256 is `ab8a99eda9fe5e0ac8fa6559c98c6198f1fc2ca26e6f69b28b95ab6fad5bb5f6`;
key ID is `jobctrl-release-v1`. The downloaded native installer independently
accepted the published archive and manifest during the disposable install below.
The unsigned channel pointer is an index: its identity and digests must match
the authenticated descriptor; its JSON alone is not signing evidence.

The [Homebrew formula at tap commit
`0f0703456140b444b6d97564b62738de06467c91`](https://github.com/ebarti/homebrew-tap/blob/0f0703456140b444b6d97564b62738de06467c91/Formula/jobctrl.rb)
selects v0.1.1, `version_scheme 1`, and the same archive, descriptor and manifest
identities above. A fresh public Homebrew command was not run on this host.

The [public curl script](https://jobctrl.dev/install.sh) has SHA-256
`5adb9cdeeefc77bda235af995ff4dc5bdb8da6852fc000652c31e8ffa208c876` and still pins
the **v0.1.0 bootstrap executable**, SHA-256
`17cf5f6eb2d5af23cd58ac66720f130731a00c749691dac1d33e2d1d33086c33`.
That bootstrap follows the compiled stable pointer. A fresh disposable public
curl acquisition **actually installed v0.1.1** and `jobctrl version --json`
reported the build ID and manifest digest above. Therefore the stale bootstrap
pin is not evidence of a different installed payload. The separate 9.6
canonical-installer cutover is still outstanding: the public script is not the
immutable v0.1.1 `install.sh` (SHA-256
`2522c7e41e6712a2c237654f755ff21a2b7602495c0ded14979b872cd0b14ce2`). This audit
neither changes the public installer nor promotes both-channel acceptance.

### Existing evidence reused

- [#949](https://github.com/ebarti/JobCtrl/issues/949) prepared v0.2.0 at
  `6a82c233c434e67f0a2d1c6df3db6aa68d036b75`.
  [Run 35607341284](https://github.com/ebarti/JobCtrl/actions/runs/35607341284)
  passed release-identity/preflight and unsigned build jobs, then remained
  **waiting** at `release-signing`; its signing job had no executed steps.
  No published v0.2.0 release was available. Its separate docs/demo deployment
  evidence and unsigned build cannot substitute for published native bytes.
  Retain that work; do not start a competing publication or bypass approval.
- The immutable v0.1.1
  [published-candidate smoke](https://github.com/ebarti/JobCtrl/releases/download/v0.1.1/published-candidate-smoke.json)
  has SHA-256 `32b89f37948e10547d031c100fa3f7db3d433139933e4d60036360bf4f12ff97`.
  It binds the exact descriptor, installer, archive and manifest and reports
  native install/start/running-status/version/stop/stopped-status success.
  [Release run 32699712597](https://github.com/ebarti/JobCtrl/actions/runs/32699712597)
  also records successful rendered-formula audit/install/test/lifecycle steps.
  These are reusable bounded lifecycle observations, not evidence of absent
  developer tools, absent Chrome, provider auth, migrations or real TTFV.
  Its Actions smoke/formula artifacts are now marked **expired**; the separate
  immutable GitHub smoke asset remains retrievable. Job conclusions do not
  reconstruct the expired per-command Homebrew output.
- The immutable [audit tar](https://github.com/ebarti/JobCtrl/releases/download/v0.1.1/jobctrl-release-audit.tar)
  has SHA-256 `608dc5b0a83161079c799f138cf4c19d9b71c386584813abb84b674e76d46532`.
  It retains notarization acceptance, SBOMs, licenses and component-size evidence.
  Its `publication-status.json` and immutable `release-metadata.json` preserve
  **pre-promotion** blocked states; the later smoke and immutable release API
  establish publication. Do not rewrite those historical assets or interpret
  their earlier status as a current failed publication. The audit size report
  describes the unsigned archive and says `baseline-not-provided`; do not use
  its compressed size as the signed ZIP size or claim a measured release delta.

### Additional published-byte checks

Ran only missing bounded checks on Apple-silicon macOS 26.6.2 in an owned
throwaway directory outside the checkout, with fresh child-process `HOME`,
`JOBCTRL_RUNTIME_HOME`, `JOBCTRL_DIR`, command directory and temporary directory.
The child received only those paths, `SHELL`, and stock system
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`; no provider credentials were supplied.
The retrieved public script was passed unchanged to `/bin/bash -s -- --home
<owned-runtime> --bin-dir <owned-bin> --no-modify-path`. No local build or fixture
installer was substituted.

| Check | Observed result and limit |
| --- | --- |
| Public curl acquisition and identity | Exit 0; native `version --json` returned v0.1.1 and the exact published build/manifest above. No source checkout was created in the disposable home. |
| Forced failed update before staging | Ran the installed `jobctrl update` under `sandbox-exec` with network access denied. Exit 1 at channel-pointer retrieval; the active receipt hash, native version and all three synthetic state-file hashes remained identical. This proves a metadata-fetch failure preserves the active selection, **not** crash recovery or failed migration after activation. |
| Default uninstall/data preservation | Installed `jobctrl uninstall` exited 0. Independent filesystem inspection found no public command symlink, runtime `bin`, or `releases`; the synthetic SQLite file, text sentinel and disabled-capability sentinel remained byte-identical. Authenticated channel state and lock files remained, as designed. The SQLite sentinel is not an application-schema migration fixture. |

No owned server was started. Existing listeners on 7233, 8233 and 8766 were
preserved; commands that could promote/start another runtime were not executed.
This host has Xcode and system Chrome, and no disposable clean macOS host was
provisioned. A fresh home and restricted PATH do **not** prove an absent
machine-wide toolchain, absent Chrome, or isolation from the user's keychain.
No personal runtime, provider auth or browser profile was adopted for this audit.

### Missing gates and next execution conditions

| Required gate | Current evidence / remaining work |
| --- | --- |
| Clean curl and Homebrew, no source/toolchain | Curl identity observed; Homebrew signed identity and historical hosted lifecycle available. Both clean native environments and fresh public Homebrew invocation still required; the Homebrew case necessarily retains Homebrew itself. |
| Same distribution on both installed paths | Curl runtime identity equals signed formula metadata. Retain fresh `version --json` results from both clean public acquisitions before marking the two-path gate passed. |
| Existing source-install state upgrade and migration | Unverified against published bytes. Use an owned synthetic supported source-schema database, test upgrade, retained backup pairing and post-upgrade invariants on the clean native host. |
| Warm and cold vendor auth / provider packs | Unverified. Requires an owner-controlled auth run; this synthetic audit supplies no credentials and cannot establish provider readiness or provider-pack operation. |
| No Chrome; core browser, doctor and domain CLI | Unverified on a machine without Chrome. Run install/start/doctor/discovery/enrichment/PDF with optional authenticated-browser capabilities disabled. |
| Explicit capability enable/disable and browser adoption | Unverified against published bytes. Use an owned browser/profile and explicit consent; no submission or personal profile adoption is implied. |
| Offline restart | Unverified. After legitimate provider setup, prove restart with package-registry access denied on an isolated native host. |
| Update, interrupted/unhealthy update, paired rollback | Only pre-staging network failure preservation observed here. Successful promotion, post-staging failure/recovery and rollback of the exact retained database/runtime pair remain unverified. |
| Default uninstall on both channels | Curl sentinel preservation observed; real supported synthetic workspace and Homebrew uninstall/data preservation remain. |
| Real-path TTFV | No accepted published-byte runs located. Three clean real runs, warm/cold auth classification, same-job API/UI/PDF proof, median/worst thresholds and release/channel binding remain required. Synthetic install timing is not TTFV. |
| Footprint and browser inventory | Published audit/manifest available; no new full inventory or baseline-delta gate claimed. Retain signed-payload inventory and measured prior-release comparison when completing acceptance. |

The current [TTFV recorder](developer/first-run-ttfv.md) is source-specific:
`scripts/install`, `uv` and `corepack pnpm dev` are its gateable defaults, and
custom install/stack commands are rejected. It therefore cannot certify the
published curl/Homebrew matrix unchanged. A bounded published-install recorder
adaptation must preserve its real discovery, same-job and PDF evidence while
binding T0 and the native release/channel; do not bypass rejection checks or
relabel source/fixture output as a published-byte run. Real auth/TTFV also lies
outside this task's synthetic-data-only scope.

Resume only the missing rows once a disposable native host and, where needed,
owner-controlled auth are available. If v0.2.0 publishes first, reconcile its
new immutable identities and invalidate release-specific v0.1.1 evidence;
do not transfer the previous build's acceptance automatically. Keep CL-082
`Roadmap` and #884 open until the applicable matrix is demonstrated.

## Historical operational snapshot — 2026-08-28

This is the **last validated snapshot**, not release evidence. At 2026-08-28,
`ebarti/JobCtrl` was public and `origin/main` was
`726ca08bd893bba2b932cd6b66835a0bf6d56f7f` (tree
`3cfb19af2d031fed0b565692e3750977ff478099`), with seven open pull requests.
The latest immutable stable release was
[`v0.1.1`](https://github.com/ebarti/JobCtrl/releases/tag/v0.1.1), published
from that commit on 2026-08-25. More PRs are expected, so the release coordinator
must still refresh `origin/main`, record the final candidate SHA and tree, and
confirm the exact candidate before each new tag; do not reuse this snapshot as
proof for a later release.

- The docs and demo are already publicly served by Cloudflare and return HTTP
  200. `DOCS_DEPLOY_ENABLED=true` and `DEMO_DEPLOY_ENABLED=true` are already
  set. Neither site needs an Access change or a visibility cutover.
- Hosted Actions execute on the public repository. Release-distribution run
  [`32699712597`](https://github.com/ebarti/JobCtrl/actions/runs/32699712597)
  completed successfully on the `v0.1.1` source commit. Every future release
  still requires actual executed hosted steps on its own audited ref; a skipped
  or zero-step run is not transferable evidence.
- The signing, Apple Developer ID/notary, R2, and Homebrew environment
  credential names are configured, as are the release public-key variables.
  The PyPI Trusted Publisher is configured and `pypi` already has a `v*` tag
  policy. Never print credential values in this checklist or its evidence.
- Every release environment admits only `v*` tags. `release-signing` is the
  single owner-review gate; `release-publication`, `release-verification`, and
  `pypi` retain their scoped credentials or configuration without reviewers.
  The active repository tag ruleset allows only the owner to create, update, or
  delete `v*` tags. Two active `main` rulesets separate universal history
  protection from update authority. The no-bypass ruleset requires pull
  requests, blocks deletion and force pushes, and requires zero approving or
  CODEOWNER reviews. The update-only ruleset exempts the owner and blocks other
  writers from direct or merged updates to `main`. Because that exemption is
  scoped to the update-only ruleset, the owner still uses a normal pull request
  and remains subject to the universal history protections, while collaborators
  retain feature-branch and pull-request contribution access.
  GitHub evaluates required-reviewer approval per job, so adding a reviewer to
  the reused `release-publication` environment would incorrectly request
  repeated approval for one release. Downstream jobs set `deployment: false`:
  they keep environment-scoped secrets, variables, tag policy, and OIDC
  identity without adding misleading deployment records. The live stable R2 pointer resolves to
  signed sequence 4 and the `v0.1.1` build. The public installer contains
  immutable `v0.1.0` pins, while the signed Homebrew tap formula is `v0.1.1`
  with `version_scheme 1`; the installer version difference remains explicit
  because its docs deployment is a separate record from the immutable release.
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
[`docs/plans/implemented/2026-07-14-end-to-end-product-redesign.md`](plans/implemented/2026-07-14-end-to-end-product-redesign.md),
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

### 9.1 — Completed repository visibility transition (owner-only history)

- **Status.** Complete. `github.com/ebarti/JobCtrl` is public. The successful
  hosted workflows and immutable releases listed in the current operational
  state supersede the pre-public assumption that Actions could not execute.
- **Historical gate.** The owner made the repository public only after the
  complete exact-tree local matrix, strict privacy and built-distribution scans,
  and the OSS spec §5 checks passed. The post-transition Release Privacy Gate,
  Docs Site, Demo Site, Native Launcher CI, Python CI, and TypeScript CI had to
  execute real steps on the audited SHA. `Sync Homebrew Tap` remained reusable
  only from the signed-release workflow.
- **Future-release rule.** Keep `python3 scripts/release_check.py` at zero
  findings and require the relevant local and hosted gates to execute on each
  release's exact SHA. Public visibility is established state, not a step to
  repeat and not evidence for a new candidate.
- **Rollback limitation.** Making the repository private would not recall
  anything already fetched and is not a substitute for the privacy gate. Treat
  a visibility change as a separate owner incident response decision, not the
  routine rollback for a failed release.

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
  - In the GA4 web data stream for `G-KB495KG6MS`, **Enhanced measurement →
    Page views → Page changes based on browser history events** is disabled.
    The docs theme sends one sanitized manual view per accepted VitePress
    route; GA4's independent history listener would otherwise double-count it.
- **Action.** Manually dispatch `Docs Site` at the audited `main` ref; do not
  toggle the already-enabled variable or wait for an unrelated push.
- **Verification.** Confirm the dispatched run SHA equals the gated and frozen
  `main` SHA, the `deploy` job runs rather than skips, and `pnpm docs:build` +
  `pnpm docs:check:runtime` are green on that built artifact. Record this
  deployment SHA separately from the immutable release/tag SHA when the later
  post-release installer/docs cutover in 9.6 changes `main`. In a fresh browser
  profile, verify the hosted site makes no Google request before consent,
  declining leaves the guide available, and acceptance records exactly one
  initial view plus one view per client-side route in GA4 Realtime or
  Tag Assistant. Reopen **Cookie settings**, withdraw, and verify later routes
  send no views.
- **Rollback.** Redeploy the previous known-good `docs-site-dist` artifact or a
  corrective audited commit. Do not represent a reverted deployment as stable
  release evidence.

### 9.3 — Repository-rename redirect (owner-only)

- **Action.** With the repository public, verify GitHub's
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
- **First release record.** `v2.0.7` is the first published stable release.
  Its immutable GitHub Release, signed R2 assets, stable channel pointer, native
  lifecycle proof, and verified Homebrew formula were published from audited
  commit `db257efe1087ec00ac2ec49b846a95d2423aecc2`. The initial PyPI upload
  stopped before publication because the publisher action referenced the
  annotated `v1.14.0` tag object rather than its peeled executable commit. The
  protected recovery completed in workflow run `30115379507`; the verified
  `2.0.7` wheel and source distribution are public on PyPI. Preserve `v2.0.7`
  and its immutable evidence.
- **Original release inputs.** The exact `v2.0.7` tag-triggered run used these
  first-release defaults:

  ```text
  release_tag=v2.0.7
  channel=stable
  sequence=1
  minimum_safe_sequence=1
  revoked_build_ids=[]
  expected_channel_pointer_sha256=absent
  ```

  The final `absent` value was required because the live stable pointer did not
  exist before this first promotion; it was the workflow's explicit
  conditional-create precondition.
  After immutable GitHub publication, the credential-free `pypi-resolve` job
  verifies the exact ref, release attestation, audit evidence, and public trust
  before the single clean PyPI builder produces checksum-bound distributions.
  The `pypi` job then publishes only those unchanged bytes through OIDC. Verify
  the PyPI package and immutable GitHub Release after the workflow succeeds.
- **Retired historical PyPI recoveries.** The bounded `v2.0.7` recovery
  completed in run `30115379507`. The `v0.1.0` recovery reproduced that tag's
  historical seven-day/`P8D` lock metadata without changing dependency versions
  or checksums, then completed the already-published package line. Both
  allowlisted recoveries are finished. The `pypi_recovery_only` input,
  main-dispatched recovery preflight, skip-propagation conditions, and special
  dependency branch have therefore been removed. `release-verification` and
  `pypi` again admit only `v*` tags. A future package correction must use a new
  audited, higher-sequence signed release rather than republishing from `main`.
- **Published `v2.0.8` security release.** The signed workflow published
  `v2.0.8` from audited commit
  `92770fe5fcc99e73c0a06e73315acbb7b506a7af` in workflow run
  `30480825567`. GitHub Releases, R2, Homebrew, and PyPI all received the
  release. Its signed descriptor advanced to sequence 2, raised the
  minimum-safe sequence to 2, and revoked only
  `2.0.7-db257efe1087ec00ac2ec49b846a95d2423aecc2-darwin-arm64`. Preserve the
  release, tag, signatures, and immutable evidence.
- **Approved `v0.1.0` public version reset.** Publish the merged
  release-preparation commit as annotated tag `v0.1.0`, then manually dispatch
  the signed workflow at the tag ref. This resets only the public application
  SemVer so JobCtrl communicates its early-access maturity accurately. The
  pre-launch `2.0.x` numbering is withdrawn, not deleted or rewritten. The
  reset is not a product, data, database-schema, migration, launcher-protocol,
  signed-sequence, build-identity, or security downgrade. There are no known
  external users; the very small public download signals are not verified
  adoption and do not establish zero historical users.

  Sequence 3 remains newer than sequence 2 even though app SemVer decreases.
  Keep minimum-safe sequence 2, carry the bytewise-sorted `v2.0.7` revocation,
  and do not revoke the safe historical `v2.0.8` build solely because of the
  numbering reset. The Homebrew template and every future render must carry
  `version_scheme 1` so Homebrew treats the new scheme as newer. Keep the
  existing `Development Status :: 4 - Beta` Python classifier. No `2.0.9`
  bridge release is required. Use these exact promotion inputs:

  ```text
  release_tag=v0.1.0
  channel=stable
  sequence=3
  minimum_safe_sequence=2
  revoked_build_ids=["2.0.7-db257efe1087ec00ac2ec49b846a95d2423aecc2-darwin-arm64"]
  expected_channel_pointer_sha256=98ce7f2a0ff19b2e7428eece939da75d160bdc991e119182246dc053898a31c2
  ```

  Re-read the public stable pointer immediately before dispatch. If its digest
  changed, stop and reconcile the intervening signed release instead of
  weakening the compare-and-swap guard.
  After `0.1.0` is verified on PyPI, yank rather than delete `2.0.7` with a
  reason that identifies the withdrawn numbering line and its security-fixed
  supersession path, and yank `2.0.8` with
  `Pre-launch version-number reset; use 0.1.0 or later.` Confirm an unpinned
  fresh install selects `0.1.0`, while exact historical pins remain available
  with a yank warning. Update the existing GitHub release descriptions without
  changing their immutable assets: label `v2.0.7` withdrawn and revoked, and
  label `v2.0.8` a safe historical build superseded by the numbering reset.
- **Approved `v0.1.1` stable increment.** Publish the merged release-preparation
  commit as annotated tag `v0.1.1`, then manually dispatch the signed workflow
  at that tag ref. This is an additive patch release on the established `0.1.x`
  line. Advance the signed anti-rollback sequence to 4, retain minimum-safe
  sequence 2, carry the bytewise-sorted `v2.0.7` revocation, and keep the safe
  `v0.1.0` build unrevoked. Use these promotion inputs:

  ```text
  release_tag=v0.1.1
  channel=stable
  sequence=4
  minimum_safe_sequence=2
  revoked_build_ids=["2.0.7-db257efe1087ec00ac2ec49b846a95d2423aecc2-darwin-arm64"]
  expected_channel_pointer_sha256=38dd07f0473bf6f8ad6c0931e42eaf1791774a2c17267eda3e425bb405fc130a
  ```

  Re-read the public stable pointer immediately before dispatch. If its digest
  changed, stop and reconcile the intervening signed release instead of
  weakening the compare-and-swap guard. After the workflow succeeds, verify
  the immutable GitHub Release, signed R2 descriptor and stable pointer,
  Homebrew formula, and `0.1.1` wheel and source distribution on PyPI before
  starting the separate canonical-installer cutover in 9.6.
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
  checklist; do not embed key-generation or clipboard commands here. Keep the
  owner as the only reviewer on `release-signing`, where protected signing
  credentials first enter the run. Keep `release-publication`,
  `release-verification`, and `pypi` without reviewers; those environments
  scope credentials or trusted configuration but are not additional human
  milestones. Every environment must admit only `v*` tags and no branches.
  Keep the active owner-only `v*` tag ruleset: together with the resolver's exact
  tag/SHA/main-lineage checks and the signing approval, it prevents a
  collaborator from manufacturing an unauthorized release tag or run. Do not
  require CODEOWNER or approving review on `main` while the repository has only
  one maintainer, because GitHub does not count an author's self-review. Keep
  the universal `main` pull-request, deletion, and non-fast-forward rules in a
  no-bypass ruleset. Keep the collaborator restriction in a separate
  update-only ruleset with the owner `exempt`; do not use `pull_request` bypass
  mode, which turns the owner's ordinary merge into an explicit protection
  bypass. The split lets collaborators push feature branches and propose pull
  requests without letting them update `main`, while the owner still cannot
  direct-push, delete, or force-push `main`. The signing approval authorizes the
  exact run/tag/SHA, and every downstream publication remains fail-closed on
  the existing `needs`,
  checksum, signature, provenance, smoke, and compare-and-swap gates. Verify the
  external PyPI Trusted Publisher mapping named in 9.4 rather than replacing it.
- **Verification.** Read back every environment rule before dispatch:
  `release-signing` has exactly the owner as required reviewer;
  `release-publication`, `release-verification`, and `pypi` have no reviewer;
  all four admit only `v*` tags; the tag ruleset restricts `v*` creation,
  update, and deletion to the owner; the universal `main` ruleset has no bypass
  actors and requires pull requests with zero approving or CODEOWNER reviews
  while blocking deletion and non-fast-forward updates; and the separate
  update-only ruleset has exactly the owner as an `exempt` actor. Confirm an
  owner-authored green pull request is normally mergeable without selecting a
  bypass, while a non-owner writer cannot update `main`. Verify every
  non-signing environment reference uses `deployment: false`, leaving the
  signing gate as the run's only GitHub deployment record.
  Dispatch at `refs/tags/<release_tag>` so `GITHUB_REF` and `GITHUB_SHA`
  identify the same audited tag and commit checked by the resolver. Confirm the
  jobs pause at `release-signing` exactly once, then advance through later
  publication jobs
  without another review request while the workflow's fail-closed input and
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
without re-rendering either. That same credential-free job verifies the
signed descriptor and formula promotion evidence, runs the Homebrew lifecycle,
and seals the tested formula against the signer's digest. It hands only the
formula to the protected deploy-key job, which checks it against the signer
output before loading credentials. There is no second tap verification job. Tap
publication never triggers from `main` or merely from a published GitHub Release.
The formula writes only its Homebrew prefix: its `bin/jobctrl` target is a
native first-invocation bootstrap holding the signed descriptor resources and
cached ZIP. It must not create `~/.jobctrl`, mutate a Cellar payload, or link a
runtime payload from the Cellar during `brew install`. The template must retain
`version_scheme 1` on this and every future render so Homebrew does not compare
the reset scheme-zero SemVer directly with the withdrawn `2.0.x` line.

- **Action.** Configure the external signing/publication gates, then run the
  implemented signed-descriptor, published-ZIP smoke, formula render,
  Ruby syntax, and Homebrew audit/test gates; atomically promote or confirm the
  signer-authored channel pointer; only then publish the smoke-tested formula
  through the protected tap job. Do not edit the tap copy by hand.
- **Rollback.** Revert `Formula/jobctrl.rb` in the tap after coordinating a
  signed release revocation; the source-development instructions are separate.

### 9.6 — Published-artifact acceptance and user-doc cutover (owner-only)

The owning contract is
[`docs/plans/implemented/2026-07-10-bundled-jobctrl-distribution-plan.md`](plans/implemented/2026-07-10-bundled-jobctrl-distribution-plan.md)
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

  1. Record the immutable `v0.1.0` tag/release SHA and tree as **R**. Retrieve
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
[`docs/plans/implemented/2026-07-11-public-live-demo-plan.md`](plans/implemented/2026-07-11-public-live-demo-plan.md).
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
3. On that final validated `main` SHA, create and push the annotated `v0.1.0`
   tag, verify the remote tag resolves to that exact SHA and remains in
   `origin/main` history, and preserve the existing `v2.0.7` and `v2.0.8` tags
   and evidence unchanged. Re-read the live stable-pointer SHA-256, then
   manually dispatch `Release distribution` at `v0.1.0` with sequence `3`,
   minimum-safe sequence `2`, only the existing bytewise-sorted `v2.0.7`
   revoked build ID, and that fresh digest as the compare-and-swap input, as
   specified in 9.4. Complete signing, notarization, lifecycle smoke,
   channel-pointer promotion, PyPI publication, Homebrew formula sync, and
   immutable release evidence as R.
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
| 9.4 Release and PyPI | Owner | Publish the `v0.1.0` early-access version reset as signed sequence 3 with minimum-safe sequence 2, the existing `v2.0.7` revocation, and the freshly re-read compare-and-swap digest; then verify every public channel and yank, not delete, PyPI `2.0.7`/`2.0.8`. |
| 9.5 Homebrew tap | Signed workflow | Publish only the signer-rendered `v0.1.0` formula and require `version_scheme 1` on this and every future render. |
| 9.6 Installer and artifact acceptance | Owner | Verify immutable `install.sh` from R, land matching `scripts/get` and `docs/public/install.sh` in a separate post-release PR, validate/deploy D, then run public curl/Homebrew smoke. |
| 9.7 Public live demo | Owner | The demo is already public and deploy is enabled; verify the audited deployment externally and record its release evidence. |
| 10 Publicization | Owner | Prepare factual assets and platform access today; on launch day announce only after the public release and command smoke pass, then cover responses and record the 1h–72h metrics. |
