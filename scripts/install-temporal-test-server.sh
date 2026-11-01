#!/usr/bin/env bash
set -euo pipefail

# The time-skipping server is distinct from the Temporal CLI. This is the
# version selected for SDK Python 1.34.0 in the hosted failure; verify the
# digest published by Temporal's GitHub release before extracting it:
# https://api.github.com/repos/temporalio/sdk-java/releases/tags/v1.40.0
if [[ "$RUNNER_OS" != "Linux" || "$RUNNER_ARCH" != "X64" ]]; then
  echo "No verified Temporal test server for $RUNNER_OS/$RUNNER_ARCH" >&2
  exit 1
fi

server_dir="$(mktemp -d "$RUNNER_TEMP/jobctrl-temporal-test-server-XXXXXX")"
archive="$server_dir/test-server.tar.gz"
trap 'rm -f -- "$archive"' EXIT
curl --fail --location --silent --show-error --retry 4 --retry-all-errors \
  --retry-delay 2 --connect-timeout 15 --max-time 120 \
  --output "$archive" \
  https://github.com/temporalio/sdk-java/releases/download/v1.40.0/temporal-test-server_1.40.0_linux_amd64.tar.gz
printf '%s  %s\n' '524465a96274831e004326f6e2f2a5f3ef9aaed72c2069cf16c1d64b8b1ec3ca' "$archive" | sha256sum --check
tar -xOf "$archive" temporal-test-server_1.40.0_linux_amd64/temporal-test-server > "$server_dir/temporal-test-server"
chmod 700 "$server_dir/temporal-test-server"
printf 'JOBCTRL_TEMPORAL_TEST_SERVER_PATH=%s\n' "$server_dir/temporal-test-server" >> "$GITHUB_ENV"
