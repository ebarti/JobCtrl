---
description: "Prepare, publish, and independently verify a signed JobCtrl release through the protected distribution workflow."
---

# Releasing JobCtrl

The release owner uses this runbook for each new version. The executable authority
is [release-distribution.yml](https://github.com/ebarti/JobCtrl/blob/main/.github/workflows/release-distribution.yml).
It builds one candidate, signs and notarizes it on a protected runner, verifies
public assets and native/Homebrew lifecycles, publishes Homebrew, promotes the
signed channel pointer, publishes the GitHub Release, and finally publishes the
stable Python package. A source version or pushed tag alone is not a release.

## Establish the candidate

1. Obtain scoped authorization to release. Use a dedicated branch/worktree from
   freshly fetched `origin/main`; preserve unrelated work. Record its full SHA,
   latest published stable tag, and every commit since that tag. Do not merge
   unrelated open PRs to expand the release.
2. Choose `MAJOR.MINOR.PATCH` from the actual changes. Review code and owning user
   guides rather than treating every commit title or design document as a shipped
   feature. Inspect exact-source CI, known blockers, and the applicable release,
   data, migration, and product evidence in [Reliability & QA](../local-reliability-qa.md).
   Respect the owner's requested release scope. An upgrade or rollback repair
   does not require a minor-version bump; its signed security sequence advances
   independently of the application version.
3. Check for an existing release run before starting another:

   ```bash
   gh release list --repo ebarti/JobCtrl --limit 5
   gh run list --repo ebarti/JobCtrl --workflow release-distribution.yml --limit 5
   git log --oneline PREVIOUS_TAG..origin/main
   ```

   Replace uppercase placeholders below with the recorded values. A failed
   preparation, build, signing, or publication attempt does not by itself justify
   advancing the application version. Keep the owner's approved version unless
   the owner approves changing it. Published versions and immutable assets must
   never be replaced.

## Prepare one release PR

Update the Python project version in `workers/automation/pyproject.toml`, its
`src/jobctrl/__init__.py`, and only the local `jobctrl` package entry in `uv.lock`.
Align `package.json`, the API/web/extension manifests, the extension's public
`manifest.json`, and the api-client/contracts/domain-types/tsconfig package
manifests. `scripts/release_check.py` owns the complete parity inventory. Update
version-bound distribution fixture expectations; do not change unrelated SDK
versions, historical notes, or registry locks.

Write `.github/releases/vVERSION.md` in the same PR. These exact bytes are audited,
retained, published, and checked again by the workflow. Include user-visible
highlights, meaningful fixes, provider/budget requirements, platform limits,
schema transitions and their data effects, update/rollback instructions, and the
previous-tag comparison link. Clearly identify any future-only work that could
otherwise be mistaken for a feature. Avoid raw commit dumps and unsupported
performance or quality claims.

Run the focused release checks from the clean worktree:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm e2e
corepack pnpm distribution:audit
python3 scripts/release_check.py --strict-prompt --release-tag vVERSION
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check
```

Changes to release shell checks need the applicable actual release-entrypoint
qualification on macOS with the system Bash. The former isolated script-test
commands are retired; use the current [operational QA gates](../local-reliability-qa.md)
and retain their real results. Do not rely on `set -e` alone to stop after a
failed `[[ ... ]]` assertion in the system Bash; make the failure explicit.

For the Python cutover, require explicit fresh-target Profile/source transfer
integrity and legacy-admission refusal, plus target-to-target lifecycle proof
with the pinned installed runtimes as documented in
[Reliability & QA](../local-reliability-qa.md). Use only owned synthetic workspaces.
Check candidate activation, paired backup, preservation, readiness failure,
rollback, and the exact Python application identity. Applicable checks and product QA must pass;
version parity and a successful build do not establish migration safety.

Use a signed-off Conventional Commit, open the PR, inspect its final diff, and
require all configured checks on the final candidate before merging. Once merged,
record the actual merge SHA and verify the release changes and source lineage.
Create and push an annotated `vVERSION` tag on that commit. Never tag an unmerged
preparation branch or move a published tag.

## Bind publication to the current channel

Download the current channel pointer as raw bytes:

```bash
curl -fsS https://releases.jobctrl.dev/v1/stable/darwin-arm64.json -o prior-pointer.json
shasum -a 256 prior-pointer.json
```

Follow its immutable descriptor/signature URLs, check their hashes against the
pointer, and verify the descriptor signature against the protected
`release-verification` public key and key ID. Downloaded trust files are audit
copies, not independent trust anchors. Set the new sequence strictly above the
current sequence. Preserve the signed descriptor's `minimumSafeSequence` and
`revokedBuildIds` unless an explicitly authorized security change requires otherwise;
never default these to `1` and `[]`. SemVer and security counters are independent.

Use the SHA-256 of the exact pointer bytes for
`expected_channel_pointer_sha256`; use `absent` only for an initial channel with
no existing pointer. Keep downloaded evidence outside the tracked tree and
refresh this comparison immediately before dispatch. A changed channel requires
reconciliation, not a blind retry.

When an authorized version correction is numerically lower than the preceding
Homebrew formula, advance the formula's `version_scheme` and its validation
contract so Homebrew recognizes it as an upgrade. A stable publication is
explicitly marked as the latest GitHub Release after its signed channel and
Homebrew promotion succeed; prereleases are not marked latest.

Dispatch the workflow **on the tag**, with the tag also supplied as its input:

```bash
gh workflow run release-distribution.yml --repo ebarti/JobCtrl --ref vVERSION \
  -f release_tag=vVERSION -f channel=stable \
  -f sequence=NEXT_SEQUENCE -f minimum_safe_sequence=EXISTING_FLOOR \
  -f revoked_build_ids='EXISTING_SORTED_JSON_ARRAY' \
  -f expected_channel_pointer_sha256=PRIOR_POINTER_SHA256
```

The sole approval-bearing environment is `release-signing`. Inspect the exact
run, candidate identity, and pending deployment before the authorized owner
approves it. Never remove or bypass environment protection to make progress.
Downstream publication environments retain scoped credentials without creating
additional approval deployments.

```bash
gh run view RUN_ID --repo ebarti/JobCtrl
gh api repos/ebarti/JobCtrl/actions/runs/RUN_ID/pending_deployments
```

If a job fails, diagnose that exact job and the public state first. Immutable
publication, Homebrew, channel promotion, GitHub publication, and PyPI can be at
different stages. Reuse the existing run where safe; do not start a competing
release, reset security counters, change an active run's note bytes, or delete
published assets.
The channel promotion uses a compare-and-swap against the prior pointer.

If a source repair is required before anything has been published, retain the
approved version. Verify that no GitHub Release, immutable candidate, channel
promotion, Homebrew publication, or PyPI distribution exists for that version.
With the owner's explicit authorization, record and preserve the old tag object
and commit, merge the repaired candidate through normal checks, and replace only
that unpublished tag using an exact expected-ref lease. Start a new run on the
corrected tag; the failed run remains evidence for its original source. Remove
an abandoned unpublished version tag only with the owner's authorization. A
published or partially published candidate requires reconciling its existing
immutable state rather than this unpublished-tag correction procedure.
If the earlier attempt already emitted a signed descriptor, keep the application
version but choose a sequence above that signed candidate as well as the current
published pointer. Never sign a different build at an already signed sequence:
clients that saw the first candidate retain its sequence-to-build binding even
when publication was held. Retain the earlier run and tag object as evidence.

For Apple HTTP 403 reporting a missing or expired agreement, stop retries until
the Apple Developer Account Holder reviews and accepts the required agreement.
Confirm the account action, recheck the candidate and current channel, then
resume the existing run when its source is unchanged. Do not rotate credentials
or bypass notarization to work around an agreement requirement.

### Resume PyPI after a partially completed release

If the GitHub Release is already public and immutable but its original workflow
failed before PyPI publication, keep the original release tag and signed assets.
The workflow has a PyPI-only recovery path; it does not build or sign a new app
candidate, change the stable pointer, or republish Homebrew. First verify the
original failed run, its successful signing, upgrade, lifecycle, pointer and
Homebrew jobs, and the current signed stable pointer. The public immutable
release must still be the latest stable release and match that pointer.

Merge the reviewed recovery workflow to `main`, then create an annotated
recovery tag on that reviewed commit. `RUN_ID` is the original failed release
run ID; the recovery tag is an execution reference, not a new app release:

```bash
git tag -a vVERSION-pypi-resume.RUN_ID REVIEWED_MAIN_SHA -m 'Resume PyPI publication'
git push origin refs/tags/vVERSION-pypi-resume.RUN_ID
gh workflow run release-distribution.yml --repo ebarti/JobCtrl \
  --ref vVERSION-pypi-resume.RUN_ID \
  -f release_tag=vVERSION -f channel=stable -F resume_pypi=true \
  -f sequence=CURRENT_SEQUENCE -f minimum_safe_sequence=EXISTING_FLOOR \
  -f revoked_build_ids='EXISTING_SORTED_JSON_ARRAY' \
  -f expected_channel_pointer_sha256=CURRENT_POINTER_SHA256
```

The recovery authority verifies the reviewed recovery ref, original run and
its successful gates, immutable release attestation, source lineage, protected
public key and exact live pointer. It also matches the immutable release's smoke
evidence to the artifact from that original run. The existing PyPI gate then
independently verifies the signed release, smoke evidence and source. Immediately
before upload, the protected PyPI job rechecks the latest release and live pointer.
Preserve the recovery tag and
both workflow runs as audit evidence. If the pointer moved, an asset differs,
or PyPI already contains part of the version, stop and reconcile rather than
overwriting or blindly retrying.

## Verify what users receive

Wait for the complete workflow, including PyPI, to succeed. Independently read back:

- The tag resolves to the recorded merge SHA and remains in current `main` history.
- GitHub exposes a published stable release with the committed notes and expected
  assets. Downloaded checksums and descriptor signatures verify; version, build
  ID, source commit, and manifest/artifact hashes agree.
- The stable channel pointer resolves to that build with the intended new
  sequence, safety floor, and retained revocations.
- The public Homebrew formula names the same version and artifact digest.
- `https://jobctrl.dev/install.sh` resolves to the same release-pinned install
  script published with the latest stable GitHub Release. Compare its bytes to
  the signed candidate’s retained `install.sh`; a stale bootstrap cannot own a
  future launcher-protocol migration.
- PyPI exposes the same package version and expected wheel/source distributions.
  Remove an inherited `UV_EXCLUDE_NEWER` cutoff when checking fresh availability.
- Workflow evidence confirms notarization, immutable public download, native
  install/start/status/stop and Homebrew lifecycle checks in disposable
  workspaces. Require the native CI suite's separate update/rollback/uninstall
  and cross-runtime migration evidence as well. Do not update or migrate a personal workspace
  merely to test a release.

Update and rollback verification must also exercise the real launcher entry
point with a resumable transition journal, including the detached supervisor.
A fresh installation and tests that replace the readiness-start function do not
prove that an authenticated candidate can start before the journal is finalized.
`scripts/released-upgrade-smoke.mjs` qualifies **the latest published stable
version before the candidate** against the signed Python candidate. The candidate
must bind the exact `launcher/application-schema.json` declaration and Python
server/worker entrypoints in its authenticated payload inventory. Launcher
protocol compatibility alone never establishes database compatibility. Unknown
application identities fail qualification.

For a legacy application database (`application_id=0`, `user_version=14` or `15`),
the harness saves a complete synthetic authored Profile through the predecessor's
actual public API and records a real Temporal workflow. Acquiring a different
candidate build into the old active runtime home succeeds as authenticated
staging; it does not activate that build or admit legacy data. The refusal proof
invokes the already staged candidate installer for first selection in the
separate fresh acquisition home with the old `JOBCTRL_DIR`, and invokes the real
Homebrew frontend against the old installation. Both must refuse legacy use
before changing the source data,
Temporal history, selectors, instance registries, transition journal or backups.
The candidate's explicit `profile-transfer` command then imports the full Profile,
baseline, style and template into a nonexistent target using a complete browser
source manifest. Native first selection uses a separate fresh runtime home as
well as the fresh application workspace, preserving the old runtime selection.
The source remains unchanged. The new target must have empty
Jobs and fresh Temporal history, preserve every authored Profile field, and pass
actual start, healthy-worker, stop and restart checks. This qualifies the
deliberate Profile-only cutover; it does not authorize an automatic in-place
upgrade or a real-user reset.

For an existing Python target (`application_id=1245926228`, `user_version=1`),
both releases must declare that exact application identity. The harness upgrades,
checks public Profile/Jobs/Discovery/Settings state and actual Temporal history,
performs an explicit paired rollback, then upgrades again through the retained
authenticated Homebrew frontend. The first pair belongs to the predecessor;
later recovery pairs belong to the candidate. The re-update interrupts the
actual controller at all eight current durable handoffs. Later canonical public
writes and real Temporal workflow histories must survive every retry, a real
readiness failure and the final selection commit. Failed startup preserves the
live pair and continues forward; it cannot automatically restore an older
snapshot. Rollback during an unfinished forward transition must refuse without
mutation. Only an explicit paired rollback after a completed compatible update
may restore accepted prior state. Installer trust failures retain the system
verifier's diagnostic; investigate it without bypassing notarization.
The disposable policy checks also revoke the running candidate: start/update
must refuse, while authenticated owned stop still retires its execution receipts
without changing the journal or selection. A revoked predecessor remains
historical handoff evidence and cannot block forward recovery. These synthetic
revocations are scoped to the private fixture policy, never a published channel.

The harness resolves that source from GitHub's published stable releases, so the
source advances automatically after each release. Drafts, prereleases and the
candidate itself are excluded; for a published historical candidate, only
releases published before it can be predecessors. Ambiguous publication times
fail the check. Its signed descriptor and artifact hashes must verify against protected
release trust, and its signed sequence must precede the candidate's.

Never-started installations, partial pairs, orphaned sidecars and process-custody
refusals remain covered by the native suite. The release gate adds actual signed
predecessor and candidate execution; a local unsigned fixture cannot replace it.

The selected case retains its report and elapsed time, with a 20-minute limit.
Publication depends directly on its success. It uses the existing self-contained
verification bundle and actual bundled runtimes without installing application
development dependencies. The signed formula-cache adapter replaces only
Homebrew acquisition. Keep installers, public Profile transfer, services and data/history
checks real; use only owned synthetic workspaces.

Both active release workflows require report schema version `2`, status `passed`
and qualification `signed-latest-stable-and-candidate`. The command has no local
trust bypass. Exported scenario helpers can support separate owned operational
proofs, but those reports must say `unqualified-for-release` and cannot satisfy
the protected publication gate. No signed predecessor/candidate run is claimed
by a local helper proof or the installed application journey suite.

Before channel promotion, the public-asset smoke verifies the immutable
descriptor, installer and artifact, runs the native lifecycle, and audits,
installs and exercises the signer-rendered Homebrew formula on a disposable
GitHub-hosted runner. It refuses an existing JobCtrl executable or keg before
mutating the Homebrew prefix. Formula sealing, protected promotion and immutable
GitHub publication still depend on that smoke succeeding.

The exhaustive public curl/Homebrew predecessor and interruption matrix is not
part of release, PR, scheduled or manual workflows. Schema upgrades, recovery,
paired-backup preservation and interruption cases belong in the full native and
worker CI suites before merge; removing the public matrix does not remove those
cases or waive the separate signed predecessor qualification above. The public
smoke has a 20-minute job budget. Its retained evidence contains public-delivery
and formula-promotion reports, not a repeated acquisition matrix. The existing
manual signed-candidate diagnostic remains available for a specific unpublished
candidate and does not invoke the public acquisition matrix.

The signed binary's opt-in test checkpoint can only pause its own process in a
marked temporary fixture; it never changes migration or release admission
decisions.

Verify the Homebrew formula with unmodified Homebrew: strict Developer ID checks
must accept the actual released executables and reject an ad-hoc control inside
the build sandbox. Live notarization belongs to the normal-user bootstrap before
installer execution and to the full-payload installer before activation. Inject
failures for both bootstrap executables and require that the installer never
runs. Do not add a global Mach-service exception or disable Homebrew's sandbox.

Report the release URL, version, exact source SHA, run result, channel sequence,
registry verification, upgrade consequences, and any unresolved limitation.
Signing success or one published channel is not completion. This repository
runbook is the canonical procedure; an optional agent skill should route here
rather than duplicate workflow commands and security policy.

<a id="schema-15-installed-upgrade-qualification"></a>

## Python application cutover and installed qualification

The previous schema-14-to-15 in-place migration is historical. The Python target
requires application ID `1245926228`, `user_version=1`, exact `app_metadata`,
and an authenticated `launcher/application-schema.json` declaration. A retained
`launcher/schema-transition.json` or historical release-smoke result is not
authority to migrate old data into this application.

Legacy application databases, legacy Temporal layout and incompatible backup
pairs must be refused without changing source data or using an old runtime
bridge. For the deliberate transition, `profile-transfer` reads an existing
source and a complete browser-source/attachment export through `--browser-sources`,
requires a nonexistent target outside the source and `--confirm-profile-only-reset`,
and preserves the full Profile and supporting sources. Other application data
starts fresh. The command emits a transfer receipt and does not select the
target. Verify the receipt and inventory before deliberately selecting it with
both `JOBCTRL_DIR=NEW_WORKSPACE` and a separate fresh
`JOBCTRL_RUNTIME_HOME=NEW_RUNTIME_HOME`. Preserve the source workspace and old
runtime home/selection. The native installer's first selection admits an
application-only database only with a complete private transfer receipt and
absent Temporal state; it consumes that one-time workspace authority before
selection. Reusing a consumed workspace under another runtime home, or an
incomplete transfer, refuses. Update and rollback continue to require a complete
authenticated pair.
The original transfer receipt remains `selected:false`; a separate durable
workspace marker records consumption before native selection. If that first
selection is interrupted, preserve the Profile, marker and source. Inspect the
interruption or explicitly transfer again into a different nonexistent target;
never automatically remove the marker, reset data or retry under another home.
Development and QA must use owned synthetic workspaces, never a real-user reset.

Later target-to-target updates and paired rollbacks must authenticate the exact
Python application identity and preserve current data. Before backup/restore,
the controller must verify owned-process cleanup and the complete paired data
authority. If candidate startup fails, retain live databases and receipts;
`jobctrl stop` followed by `jobctrl update` continues forward. Never automatically
restore an earlier snapshot over possible later commits. Unresolved accounting,
unknown process ownership or an incompatible pair refuses the operation.

Source merge and unsigned synthetic payloads do not establish a published
upgrade. Before publication, exercise the actual signed/notarized installer
and target through curl and unmodified Homebrew, preserving predecessor
authentication and revocation checks. Prove legacy refusal, current-target
start/stop/restart, update/backup/rollback, interruption and readiness failure,
forward recovery, and preservation of app/Temporal WAL and unrelated files.
Use real entry points; an old executable pathname passed to a new in-process
implementation does not establish an archived-binary boundary.

The current local native lifecycle/custody partitions and pinned installed
application suite are documented in
[Reliability & QA](../local-reliability-qa.md#schema-15-forward-upgrade).
Their local passes do not replace signed acquisition or release-specific
predecessor qualification. Preserve the protected signing, notarization,
manifest, platform and publication gates when updating the release harness.
