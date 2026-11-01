#!/usr/bin/env bash
set -euo pipefail

# Hosted browser setup must not spend the entire job waiting for a stale mirror.
# Keep the runner's repositories, signing keys and package verification intact.
if [[ "${CI:-}" != true || "${RUNNER_OS:-}" != Linux || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'APT transport configuration requires a GitHub-hosted Linux job.' >&2
  exit 1
fi
sudo tee /etc/apt/apt.conf.d/80jobctrl-ci-transport > /dev/null <<'CONFIG'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "2";
CONFIG
