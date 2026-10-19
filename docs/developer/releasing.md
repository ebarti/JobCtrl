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
rollback, and supported source schemas. Applicable review and QA gates must pass;
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
The protected release workflow also runs `scripts/released-upgrade-smoke.mjs`
against the actual published 0.1.0, 0.1.1, 0.2.0, 0.2.1 and 0.3.0 executables and the signed
candidate before any immutable publication or stable promotion. Its isolated signed formula-cache adapter
replaces only Homebrew acquisition; native installers, migrations, services,
readiness failure, explicit rollback, interrupted recovery, paired backups and
repeated update execute through the real binaries. Retain the credential-free
`released-upgrade-smoke.json` evidence and require every matrix case to pass.
Include a separate workspace that first reproduces the released 0.2.1-to-0.3.0
failure, then recovers it using the new authenticated formula controller.
The serial matrix retains time for real installer notarization and repeated
service restarts; do not shorten it to a version-only check to fit a timeout.
Also upgrade a real 0.2.1 installation that has never started or created either
database, then roll back its initialized predecessor pair. Partial pairs and
orphaned sidecars must fail before any selection change in the native suite.

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
