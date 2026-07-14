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
publish *mechanics* that feed the gate. The sole sequencing exception is the
owner decision recorded on 2026-07-10: because GitHub refuses to start the
private-repository jobs under the current billing state, the owner may flip
visibility after the complete exact-tree local gate passes solely to unblock
the hosted runs. Docs deployment, release tagging, Homebrew stable publication,
and PyPI publication remain prohibited until every hosted gate is then green.

## Owner-only actions (do not execute here)

Every state-changing step below is an **owner-only** action. Implementing agents
prepare and run read-only verification; the repository owner executes. The
R7a/R7b split is historical now that the rename and launch-readiness artifacts
have landed. The remaining gates are the release gate plus the active bundled
distribution and public-demo plans.

## Current launch snapshot (re-verified 2026-07-14)

This is a dated observation, not permission to publish and not a substitute for
rerunning the checks on the final release SHA.

- `main` is `47cfba58`; `ebarti/JobCtrl` is still **private**. The repository
  description and `https://jobctrl.dev` homepage metadata are set.
- `python3 scripts/release_check.py --strict-prompt` and
  `pnpm distribution:audit` pass locally on that tree. The tracked signing
  policy remains fail-closed as `blocked-awaiting-credentials` by design; the
  release workflow may derive a ready policy only after its protected inputs
  resolve.
- Release Privacy, Docs Site, Demo Site, Native Launcher CI, Python CI, and
  TypeScript CI are all active, but their latest jobs on `47cfba58` failed with
  zero executed steps under the current private-repository billing/plan state.
  They are neither product failures nor passing evidence.
- `jobctrl.dev` and `demo.jobctrl.dev` have deployed candidates, but an external
  non-allowlisted request receives Cloudflare Access `403`. The docs deployment
  variable is unset; `DEMO_DEPLOY_ENABLED=true` is set. Neither candidate has
  completed public cutover.
- The claims ledger is owner-signed, but GATE G1 is still open: its last anchor
  is `15356b39`, not current `main`, and the final post-merge freeze SHA has not
  been recorded.
- The release signing, publication, verification, and PyPI environments exist;
  the PyPI environment has a `v*` tag-only policy. Required reviewers and the
  remaining tag-only environment policies are not configured under the current
  repository plan. There is no `v2.0.0` tag, immutable GitHub Release, stable R2
  channel pointer, or signed/notarized public artifact. PyPI contains only the
  `0.0.1` name-holding marker release.
- `ebarti/homebrew-tap` is public and still contains the legacy HEAD-only,
  source-bootstrap `Formula/jobctrl.rb`; it has no stable spec and is not the
  signed v2.0.0 distribution. Step 9.5 must replace it through the sealed
  release workflow before Homebrew is advertised as a stable install path.
- The owner explicitly deferred W2.4 per-lane spend attribution and token
  ceilings for v2.0.0 on 2026-07-10. The shipped application-wide estimated
  daily USD ceiling remains; W2.4 is backlog, not an unresolved launch choice.

## Steps

### 9.1 — Repository visibility flip (owner-only)

- **Action.** Owner flips `github.com/ebarti/JobCtrl` from private to public.
- **Verification.**
  - Before the flip, run the complete local matrix on the exact `main` tree,
    including strict release/privacy scanning and built-distribution scanning.
  - Immediately after the flip, rerun Release Privacy, Docs Site, Demo Site,
    Native Launcher CI, Python CI, and TypeScript CI on that exact `main` SHA.
    `Sync Homebrew Tap` is reusable only from the later signed-release workflow;
    it is not a standalone post-flip build gate. The current private-repository
    runs are zero-step billing failures and are not passing evidence. If Release
    Privacy fails after actually executing, return the repository to private
    while investigating. Any other hosted failure blocks docs/demo cutover,
    tagging, and publication.
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

### 9.2 — Docs-site deploy (owner-only)

> **Current state 2026-07-14.** A candidate is deployed at `jobctrl.dev` behind
> Cloudflare Access: the allowlisted local probe serves the site and an external
> non-allowlisted probe receives `403`. `DOCS_DEPLOY_ENABLED` is unset, so the
> hosted workflow cannot update the candidate. This is staged infrastructure,
> not a completed public deploy.

- **Preconditions (OSS spec §5 gate).** Deploying `docs/.vitepress/dist` to the
  public `jobctrl-docs` Cloudflare project is itself a going-public act, so it
  carries the **same OSS spec §5 gate as 9.1**. The `deploy` job in
  `docs-site.yml` is gated only on `DOCS_DEPLOY_ENABLED` and `main` — **not**
  on `release-check` — so this checklist is the
  only guard. Before setting `DOCS_DEPLOY_ENABLED` or configuring the Cloudflare
  secrets:
  - `python3 scripts/release_check.py` reports zero findings locally on the
    exact commit to be deployed, and `release-check`
    (`.github/workflows/release-check.yml`) is green on that `main` commit.
  - Every box in OSS spec §5 is checked — in particular the W0.\* privacy
    scanner, the owner's recorded capability-posture acceptance, and the final
    human manual QA — exactly as required for 9.1.
  - The claims-ledger freeze (`docs/claims-ledger.md`, GATE G1) is re-stamped at
    the actual freeze `main` sha and owner-signed, so the public site cannot
    ship provisional or unsigned public claims.
- **Action.** Set the repository variable `DOCS_DEPLOY_ENABLED=true` and the two
  Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) so the
  `deploy` job in `.github/workflows/docs-site.yml` runs from `main` (it is
  gated on `vars.DOCS_DEPLOY_ENABLED == 'true'` and `main`;
  it deploys `docs/.vitepress/dist` to the Cloudflare Pages project
  `jobctrl-docs`).
- **Verification.** On the next `main` push the `deploy` job runs (not skipped),
  the site serves from an external non-allowlisted network without a Cloudflare
  Access challenge, and `pnpm docs:build` + `pnpm docs:check:runtime` are green
  on the built artifact.
- **Rollback.** Re-enable the Cloudflare Access restriction (or otherwise
  disable the public custom domain), then unset `DOCS_DEPLOY_ENABLED` so future
  deploy jobs skip. If a bad build shipped, redeploy the previous
  `docs-site-dist` artifact before reopening access. Unsetting the variable
  alone does not withdraw an already deployed Pages site.

### 9.3 — Repository-rename redirect (owner-only; rename landed 2026-07-07)

> **Update 2026-07-07.** The rename train
> ([`docs/plans/implemented/2026-07-05-rename-jobctrl-plan.md`](plans/implemented/2026-07-05-rename-jobctrl-plan.md))
> has merged and the repository is `ebarti/JobCtrl`; `REPO_URL` already points
> at it. What remains is verifying the old-URL redirects at the visibility
> flip.

- **Action.** After the visibility flip, verify GitHub's
  automatic old-URL redirects resolve; `REPO_URL` in
  `docs/.vitepress/config.ts` and the README badges already point at
  `ebarti/JobCtrl`; re-run `pnpm docs:build` if any link needed fixing.
- **Rollback (for reference).** Rename back (GitHub reserves the prior name);
  revert the `REPO_URL`/link edits.

### 9.4 — Release tagging (owner-only; rename landed 2026-07-07)

> **Update 2026-07-11.** The distribution is renamed (`pyproject` name
> `jobctrl`) and stable-only package publishing is integrated into
> `.github/workflows/release-distribution.yml`. It runs only after that same
> owner-dispatched workflow has published and verified an immutable,
> non-prerelease GitHub Release. The standalone `release-pypi.yml` path is
> intentionally absent, and `.github/workflows/publish.yml` stays disabled, so
> older tagged commits cannot supply the former tag-push publication logic.
> `release_check` enforces the distribution name, one version across every
> shipped manifest and built distribution, and an exact `v<version>` tag.
> Unrestricted manual and tag-push publishing are disabled. The
> GitHub `pypi` environment exists and admits only `v*` tags; add a required
> reviewer after the visibility/plan change makes that protection available.
> The historical "Publish to PyPI" workflow remains `disabled_manually`.
> The owner selected **v2.0.0** as the first public release version on
> 2026-07-10. All shipped manifests are prepared at that version before the
> tag; publishing the tag remains an owner-only action after hosted gates pass.

> **Current state 2026-07-14.** The protected environment records and release
> secret names are present, and the PyPI environment admits only `v*` tags, but
> no required reviewer is configured and the other release environments have no
> tag-only deployment policy under the current private-repository plan. No
> `v2.0.0` tag, immutable GitHub Release, stable R2 pointer, or v2.0.0 PyPI file
> exists.

- **Action.** Re-check that the `jobctrl` PyPI name is still available and
  configure/verify its Trusted Publisher immediately before release. A pending
  publisher can create the project on first publish but does **not** reserve the
  name ([PyPI documentation](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)).
  Confirm the owner-approved first version and configure the Trusted Publisher
  for workflow `release-distribution.yml` and environment `pypi`. Dispatch the
  signed distribution workflow with an exact tag targeting audited current
  `main`. After immutable GitHub publication, its clean `pypi-resolve` job
  checks out that exact ref without credentials, verifies the tracked finalizer
  bundle and license notice, verifies the immutable Release attestation, safely
  extracts the audit evidence with system Python, and validates the signed P6
  candidate against the protected public key and key ID before any project
  dependency runs. Two independent builders then install only the locked
  `release-build` group (`build` and Hatchling), create fixed-epoch wheel and
  source archives without isolation, and run the strict scanner. A fresh job
  byte-compares both inventories and authors the publication checksum. The
  separate `pypi` job has no checkout, build tools, or release-key inputs: it
  re-resolves the tag and current `main`, verifies only the compare-sealed
  artifact, and uses OIDC to publish those unchanged bytes. Verify the PyPI
  package and immutable GitHub Release after the workflow succeeds.
- **Rollback.** Preserve the immutable Release and tag as audit evidence. Yank
  a bad PyPI file/version when necessary, then publish a new higher-sequence
  signed release that explicitly revokes or supersedes the affected build.

### 9.4a — Signed distribution environments (owner-only)

Before dispatching `Release distribution`, configure the following protected
GitHub environments. Keep private values in environment secrets; keep the
public Ed25519 trust anchor in protected environment variables. Do not write
either into the tracked signing policy. Configure **every** environment below
with a deployment tag rule matching only protected `v*` tags; do not admit
branches. Dispatch the workflow at `refs/tags/<release_tag>` so its own
`GITHUB_REF` and `GITHUB_SHA` are the same audited tag/commit checked out by
the resolver. These environment rules are the server-side defense against a
modified branch workflow removing the in-workflow identity check:

Generate the JobCtrl Ed25519 release key pair once, outside the repository. This
key signs JobCtrl manifests and release descriptors; it is separate from the
Apple Developer ID certificate used to sign macOS executables:

```bash
release_key_dir="$HOME/.jobctrl-release-secrets"
(
  set -euo pipefail
  umask 077
  mkdir -p "$release_key_dir"
  chmod 700 "$release_key_dir"
  private_der="$release_key_dir/jobctrl-release-v1.pk8"
  if [[ -e "$private_der" ]]; then
    echo "release key already exists; refusing to overwrite it" >&2
    exit 1
  fi
  node --input-type=module - "$private_der" <<'NODE'
import { writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
const privateDer = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
writeFileSync(process.argv[2], privateDer, { flag: "wx", mode: 0o600 });
NODE
)
```

Back up the private-key file offline. Never commit it. Copy the canonical
base64 PKCS#8 DER value for the `JOBCTRL_RELEASE_SIGNING_KEY` environment secret,
then paste it into `release-signing` before running the next clipboard command:

```bash
base64 < "$release_key_dir/jobctrl-release-v1.pk8" | tr -d '\n' | pbcopy
```

Derive and copy the matching raw 32-byte public key for the
`JOBCTRL_RELEASE_PUBLIC_KEY` environment variable in `release-verification`:

```bash
node --input-type=module - "$release_key_dir/jobctrl-release-v1.pk8" <<'NODE' | pbcopy
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";

const privateDer = readFileSync(process.argv[2]);
const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("release key is not Ed25519");
const spki = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
const prefix = Buffer.from("302a300506032b6570032100", "hex");
if (spki.length !== 44 || !spki.subarray(0, prefix.length).equals(prefix)) {
  throw new Error("unexpected Ed25519 public-key encoding");
}
process.stdout.write(spki.subarray(prefix.length).toString("base64"));
NODE
```

Set `JOBCTRL_RELEASE_KEY_ID` to `jobctrl-release-v1`. The signing workflow
derives the public key from the protected private key and fails unless it
exactly matches the independently protected verification value.

- `release-signing`: `JOBCTRL_RELEASE_SIGNING_KEY`,
  `JOBCTRL_APPLE_DEVELOPER_ID_P12`,
  `JOBCTRL_APPLE_DEVELOPER_ID_PASSWORD`, `JOBCTRL_APPLE_SIGNING_IDENTITY`,
  `JOBCTRL_APPLE_NOTARY_PROFILE`, `JOBCTRL_APPLE_NOTARY_API_KEY`,
  `JOBCTRL_APPLE_NOTARY_KEY_ID`, and `JOBCTRL_APPLE_NOTARY_ISSUER`. Require an
  owner approval. The signing job starts on a fresh runner only after locked
  dependencies and both unsigned comparison builds have passed; it performs no
  package installation and runs only the sealed finalizer plus system signing
  and notarization tools.
- `release-publication`: environment secrets `JOBCTRL_R2_ACCESS_KEY_ID`,
  `JOBCTRL_R2_SECRET_ACCESS_KEY`, `JOBCTRL_RELEASE_ADMIN_READ_TOKEN` (a
  fine-grained token with repository Administration read access), and
  `HOMEBREW_TAP_DEPLOY_KEY`; plus protected environment variables
  `JOBCTRL_R2_ACCOUNT_ID` and `JOBCTRL_R2_BUCKET`. The R2 access key must have
  Object Read & Write permission scoped only to the release bucket. Keep the
  credentials as environment secrets; the reusable Homebrew workflow resolves
  the tap key only inside its `publish` job after the environment approval,
  rather than accepting it through `workflow_call`. Require a separate owner
  approval. Publication writes directly to the configured R2 S3 endpoint with
  conditional `PutObject` (`If-Match` / `If-None-Match: *`), then verifies the
  resulting bytes through `https://releases.jobctrl.dev`.
- `release-verification`: protected environment variables
  `JOBCTRL_RELEASE_PUBLIC_KEY` and `JOBCTRL_RELEASE_KEY_ID`, the non-secret but
  integrity-sensitive release trust anchor. Require an owner approval. The
  credential-free distribution-prepare jobs embed this key. After immutable
  GitHub publication, the clean PyPI resolution gate checks against the same
  protected values before dependency execution; the two builders receive
  neither value. None of those jobs receives an OIDC token or publication
  authority.
- `pypi`: configure only the PyPI Trusted Publisher. Require an owner approval
  and the same protected `v*` tag-only deployment rule.
  The OIDC-only publish job receives no checkout, build tooling, dependencies,
  or release-key inputs; it receives only the compare-sealed package bytes and
  checksum.

Dispatch supplies the full expected SHA-256 of the currently served channel
pointer (or `absent` only for the first one). Two fresh macOS runners build
unsigned candidates independently; a third runner compares them before the
credentialed signer receives either. Fresh runners then isolate signing,
immutable draft publication, pointer CAS, tap publication, and final GitHub
Release publication from dependency installation and repository execution. A
separate credential-free runner smoke-tests the public build-scoped assets and
runs Homebrew audit/install/test. Only then does the minimal CAS job promote
the signer-authored channel pointer. The top-level concurrency key serializes
each channel/platform, and the stable tap job cannot start until that pointer
promotion succeeds or proves the exact pointer is already live. An exact
existing pointer is a safe resume; a different or stale pointer is a deliberate
conflict that fails before Homebrew can be changed. The workflow publishes and
post-lock verifies the immutable GitHub Release after pointer and tap
publication; only the stable channel can then enter the clean two-builder PyPI
lane.

**Current hosted-release status.** The `jobctrl-releases` R2 bucket,
`https://releases.jobctrl.dev` custom domain, and repository immutable Releases
are provisioned. The release signing/notarization secret names, R2 credentials,
administration-read token, Homebrew deploy key, account ID, bucket, and release
verification variables are configured. GitHub currently rejects the remaining
required-reviewer and tag-policy protection for this private repository under
its billing/plan state, and Actions jobs are zero-step blocked by the same
account state. Restore billing/plan access, configure the missing owner
approvals plus `v*`-tag-only deployment policies, and complete the first live
signed-release verification. The staged README/docs already contain curl and
Homebrew commands, so keep the repository and docs candidate access-restricted
until those hosted gates have completed.

### 9.5 — Homebrew tap publication (signed-release-gated)

`packaging/homebrew/Formula/jobctrl.rb.tmpl` is the one canonical formula
template in this repository. The public `ebarti/homebrew-tap` currently carries
a legacy HEAD-only source-bootstrap formula with no stable spec; it is not a
render of this template and is not release evidence. The implemented P6 signer
job renders the replacement formula once from the signed stable descriptor and
exports its exact SHA-256. A credential-free job
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

### 9.6 — Public live-demo cutover (owner-only)

The owning implementation and privacy contract is
[`docs/plans/2026-07-11-public-live-demo-plan.md`](plans/2026-07-11-public-live-demo-plan.md).
P0–P7 are merged and a production candidate is deployed, but the plan remains
active until public cutover and its Definition of Done are complete.

- **Preconditions.** The exact-tree local gate and all post-public hosted gates
  in 9.1 pass. The owner approves the controller identity, privacy contact,
  public privacy/cookie notice, Cloudflare processor/transfer posture, and the
  lawful basis and copy for the acceptance-required consent gate and disclosed
  non-linkable operational counters. The claims ledger is frozen at the release
  SHA. No Blocker/High security, review, or QA finding remains.
- **Action.** On the approved deployment, remove the Cloudflare Access IP
  restriction from `demo.jobctrl.dev`, publish the docs-site Live Demo CTA, and
  leave `DEMO_DEPLOY_ENABLED=true` only while production deployment from
  audited `main` is intended.
- **Verification.** From an external non-allowlisted network and a fresh browser
  profile, direct routes load; only the static consent shell exists before a
  decision; decline redirects to `jobctrl.dev`; confirmed consent initializes
  only the isolated synthetic workspace; irreversible effects remain simulated;
  product-state values never cross the telemetry boundary; D1 retention,
  security headers, production smoke, and rollback rehearsal pass. Record the
  exact deployment/SHA evidence required by the demo plan.
- **Rollback.** Re-enable the Cloudflare Access restriction first, disable
  `DEMO_DEPLOY_ENABLED`, restore the previous Pages/Worker deployment and D1
  bindings if needed, and withdraw the public CTA. Preserve audit evidence for
  the failed cutover.

## Status summary

| Step | Owner-only | Rename-gated | Status |
| --- | --- | --- | --- |
| 9.1 Visibility flip | Yes | No | Repo private; local privacy/distribution gates green at `47cfba58`; hosted jobs still fail before executing |
| 9.2 Docs-site deploy | Yes | No | Candidate behind Cloudflare Access; deploy variable unset; public cutover waits for hosted gates |
| 9.3 Rename redirect | Yes | Landed 2026-07-07 | Redirect verify at flip; owner executes |
| 9.4 Release tagging | Yes | Landed 2026-07-07 | v2.0.0 selected; environment inputs mostly configured; blocked until protections and post-public hosted gates pass |
| 9.5 Homebrew tap | Signed artifact only | No | Signed workflow is ready; legacy HEAD-only public formula must be replaced by the verified v2.0.0 render after release-origin and hosted gates pass |
| 9.6 Public live demo | Yes | No | Private candidate behind Cloudflare Access; blocked on post-public hosted gates, owner privacy/legal approval, access removal, and external smoke/rollback evidence |
