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
corepack pnpm scripts:test
corepack pnpm distribution:audit
python3 scripts/release_check.py --strict-prompt --release-tag vVERSION
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check
```

For a schema transition, require native cross-runtime migration proof with the
locked Python and installed Node runtimes bound as documented in
[Reliability & QA](../local-reliability-qa.md). Use only owned synthetic workspaces.
Check candidate activation, paired backup, preservation, readiness failure,
rollback, and supported source schemas. Applicable checks and product QA must pass;
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

## Verify what users receive

Wait for the complete workflow, including PyPI, to succeed. Independently read back:

- The tag resolves to the recorded merge SHA and remains in current `main` history.
- GitHub exposes a published stable release with the committed notes and expected
  assets. Downloaded checksums and descriptor signatures verify; version, build
  ID, source commit, and manifest/artifact hashes agree.
- The stable channel pointer resolves to that build with the intended new
  sequence, safety floor, and retained revocations.
- The public Homebrew formula names the same version and artifact digest.
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
The protected release workflow runs `scripts/released-upgrade-smoke.mjs` against
actual released executables before immutable publication. Its ordinary compatible
protocol case upgrades from
**the latest published stable version before the candidate**, rolls back to that
version with its paired data backup, then explicitly upgrades again. For the
protocol-1/schema-14 to protocol-2/schema-15 transition, it verifies the old
controller's refusal, interrupts the signed new installer after selector
handoff, preserves later application and Temporal WAL writes through forward
recovery, and checks that cross-protocol rollback is refused. Both cases check
real service readiness, retained job data and Temporal history.

The harness resolves that source from GitHub's published stable releases, so the
source advances automatically after each release. Drafts, prereleases and the
candidate itself are excluded; a rerun after publication still tests the previous
release. Its signed descriptor and artifact hashes must verify against protected
release trust, and its signed sequence must precede the candidate's.

Historical source schemas, detailed readiness-fault injection, old failed
transitions, never-started installations, partial pairs and orphaned sidecars
remain covered by the native suite. Do not repeat that compatibility matrix in
every release's publication gate.

The selected case retains its report and elapsed time, with a 20-minute limit.
Publication depends directly on its success. It uses the existing self-contained
verification bundle and actual bundled runtimes without installing application
development dependencies. The signed formula-cache adapter replaces only
Homebrew acquisition. Keep installers, migrations, services and data/history
checks real; use only owned synthetic workspaces.

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

## Schema-15 installed upgrade qualification

The authenticated new installer owns the protocol-1/schema-14 to
protocol-2/schema-15 transition. Historical controllers, including v0.3.1,
must reject the protocol-2-only target before backup or journaling. Run the
new release's verified installer against the original runtime home; retain the
predecessor receipt and immutable payload as historical authentication evidence.
The predecessor is never executed during this forward path. No bridge catalog,
bridge release, or reboot is a migration prerequisite.

Before taking a paired, SQLite-online backup, the new controller requests clean
exit for instance-owned processes and descendants, kills verified leftovers only
after the shutdown timeout, and waits for exit. A real inspection or cleanup
failure blocks migration and preserves the databases and journal. A restart
normally follows successful cleanup; reboot is last-resort troubleshooting for
an actual cleanup failure.

The signed payload inventory must bind `launcher/schema-transition.json` to
source schema 14 and target schema 15. Exact-v14 activation applies the additive
migration in place, preserving the database inode. A failed or interrupted
attempt preserves the live pair. Before selector replacement, retry the
trusted new installer: the immutable protocol-1 public binary cannot decode
the protocol-2 journal. After replacement, ordinary `jobctrl update` resumes
through the new controller. Each attempt backs up the current live pair, including acknowledged WAL writes;
it never restores an earlier snapshot over newer data or restarts retired code.
A cross-protocol rollback is refused. A first install cannot adopt a schema-14
workspace without its original authenticated predecessor selection; an exact-v15
reinstall preserves data after normal cleanup.

Source merge and synthetic fixtures do not establish an available or qualified
installed upgrade. Before first publication/use, exercise the actual signed,
notarized installer and target through both curl and unmodified Homebrew,
including archived-controller rejection, normal start/stop/restart, interruption
and readiness failure, repeated forward recovery, revoked predecessor evidence,
revoked-target startup/update refusal, pure cleanup of a revoked target's owned
writers, and protected app/Temporal WAL and external-file bytes. Run the archived
public binary at each pre-selector interruption and the new installer retry
through its actual entry; calling the new `Run` implementation with an old
executable pathname proves neither of those process boundaries.
Use owned synthetic workspaces and the matrix in
[Reliability & QA](../local-reliability-qa.md#schema-15-forward-upgrade).
The historical release-smoke upgrade/rollback cycle must not be claimed as
cross-protocol upgrade evidence: qualify the new installer path and explicit
cross-protocol rollback refusal separately.
