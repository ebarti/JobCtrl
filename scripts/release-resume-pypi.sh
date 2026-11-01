#!/usr/bin/env bash
# Authorize a PyPI-only retry from a reviewed recovery tag. The published
# release and its original run remain the authority for the package source.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_OUTPUT:?}" "${RUNNER_TEMP:?}"
: "${RELEASE_TAG:?}" "${RELEASE_SEQUENCE:?}" "${EXPECTED_CHANNEL_POINTER_SHA256:?}"
: "${JOBCTRL_RELEASE_PUBLIC_KEY:?}" "${JOBCTRL_RELEASE_KEY_ID:?}"

[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid RELEASE_TAG" >&2; exit 1; }
[[ "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid RELEASE_SEQUENCE" >&2; exit 1; }
[[ "$EXPECTED_CHANNEL_POINTER_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid EXPECTED_CHANNEL_POINTER_SHA256" >&2; exit 1; }
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid GITHUB_SHA" >&2; exit 1; }
[[ "$JOBCTRL_RELEASE_KEY_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid JOBCTRL_RELEASE_KEY_ID" >&2; exit 1; }
prefix="refs/tags/$RELEASE_TAG-pypi-resume."
[[ "$GITHUB_REF" == "$prefix"* ]] || { echo "Invalid GITHUB_REF" >&2; exit 1; }
original_run="${GITHUB_REF#"$prefix"}"
[[ "$original_run" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid original_run" >&2; exit 1; }

test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test "$(gh api "repos/$GITHUB_REPOSITORY/commits/${GITHUB_REF#refs/tags/}" --jq '.sha')" = "$GITHUB_SHA"
recovery_relation="$(gh api "repos/$GITHUB_REPOSITORY/compare/$GITHUB_SHA...main" --jq '.status')"
case "$recovery_relation" in ahead|identical) ;; *) echo "Release commit is not in main history" >&2; exit 1 ;; esac
source_commit="$(gh api "repos/$GITHUB_REPOSITORY/commits/$RELEASE_TAG" --jq '.sha')"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid source_commit" >&2; exit 1; }
source_relation="$(gh api "repos/$GITHUB_REPOSITORY/compare/$source_commit...main" --jq '.status')"
case "$source_relation" in ahead|identical) ;; *) echo "Release commit is not in main history" >&2; exit 1 ;; esac
source_date_epoch="$(git show -s --format=%ct "$source_commit")"
[[ "$source_date_epoch" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid source_date_epoch" >&2; exit 1; }

run_json="$RUNNER_TEMP/original-release-run.json"
jobs_json="$RUNNER_TEMP/original-release-jobs.json"
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$original_run" > "$run_json"
jq -e --arg tag "$RELEASE_TAG" --arg sha "$source_commit" \
  '.path == ".github/workflows/release-distribution.yml" and .event == "workflow_dispatch" and .head_branch == $tag and .head_sha == $sha and .status == "completed" and .conclusion == "failure"' \
  "$run_json" >/dev/null
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$original_run/jobs?per_page=100&filter=latest" > "$jobs_json"
required_jobs=(
  "Resolve the audited release identity and protected public trust"
  "Build unsigned candidate once"
  "Preflight checkout-free GitHub publication access"
  "Sign and notarize on a fresh protected runner"
  "Package signed audit evidence without credentials"
  "Qualify the latest stable transition"
  "Publish the signed immutable candidate from a fresh runner"
  "Smoke public assets and verify the native and Homebrew lifecycles"
  "Atomically promote only the signer-rooted pointer"
  "Publish the verified stable Homebrew formula"
)
for name in "${required_jobs[@]}"; do
  jq -e --arg name "$name" '[.jobs[] | select(.name == $name)] | length == 1 and .[0].conclusion == "success"' "$jobs_json" >/dev/null
done
jq -e '[.jobs[] | select(.name == "Publish the verified GitHub Release")] | length == 1 and (.[0].conclusion == "success" or .[0].conclusion == "failure")' "$jobs_json" >/dev/null

release_json="$RUNNER_TEMP/published-release.json"
gh release view "$RELEASE_TAG" --json isDraft,isPrerelease,isImmutable,targetCommitish,assets > "$release_json"
jq -e --arg sha "$source_commit" '.isDraft == false and .isPrerelease == false and .isImmutable == true and .targetCommitish == $sha' "$release_json" >/dev/null
test "$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq '.tag_name')" = "$RELEASE_TAG"
gh release verify "$RELEASE_TAG"
pointer_digest="$(jq -er '[.assets[] | select(.name == "channel-pointer.json")] | if length == 1 then .[0].digest else error("missing or duplicate pointer") end' "$release_json")"
test "$pointer_digest" = "sha256:$EXPECTED_CHANNEL_POINTER_SHA256"
pointer="$RUNNER_TEMP/current-stable-pointer.json"
curl -fsS --max-time 30 https://releases.jobctrl.dev/v1/stable/darwin-arm64.json -o "$pointer"
test "$(shasum -a 256 "$pointer" | awk '{print $1}')" = "$EXPECTED_CHANNEL_POINTER_SHA256"
jq -e --arg build "${RELEASE_TAG#v}-$source_commit-darwin-arm64" --argjson sequence "$RELEASE_SEQUENCE" \
  '.channel == "stable" and .buildId == $build and .sequence == $sequence' "$pointer" >/dev/null

key="$RUNNER_TEMP/protected-release-public-key"
printf %s "$JOBCTRL_RELEASE_PUBLIC_KEY" | base64 --decode > "$key"
test "$(wc -c < "$key" | tr -d ' ')" = 32
test "$(base64 -w0 < "$key")" = "$JOBCTRL_RELEASE_PUBLIC_KEY"
{
  echo "original_run_id=$original_run"
  echo "source_commit=$source_commit"
  echo "source_date_epoch=$source_date_epoch"
  echo "release_public_key=$JOBCTRL_RELEASE_PUBLIC_KEY"
  echo "release_key_id=$JOBCTRL_RELEASE_KEY_ID"
} >> "$GITHUB_OUTPUT"
