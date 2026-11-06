#!/usr/bin/env bash
set -euo pipefail

# Hosted browser setup must not spend the entire job waiting for a stale mirror.
# Keep the runner's repositories, signing keys and package verification intact.
if [[ "${CI:-}" != true || "${RUNNER_OS:-}" != Linux || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'APT transport configuration requires a GitHub-hosted Linux job.' >&2
  exit 1
fi
# The image already lists these three Ubuntu archives. Prefer its HTTPS
# alternatives: a continuously slow Azure download never trips an idle timeout.
# Keep the same repositories, suites, signing keys and package verification.
if [[ -f /etc/apt/apt-mirrors.txt && ! -L /etc/apt/apt-mirrors.txt ]]; then
  sudo python3 - <<'PY'
from pathlib import Path

mirrors = Path("/etc/apt/apt-mirrors.txt")
priorities = {
    "https://archive.ubuntu.com/ubuntu/": 1,
    "https://security.ubuntu.com/ubuntu/": 2,
    "http://azure.archive.ubuntu.com/ubuntu/": 3,
}
lines = mirrors.read_text().splitlines()
present = {line.split()[0] for line in lines if line.strip() and not line.lstrip().startswith("#")}
if not priorities.keys() <= present:
    raise SystemExit("Hosted Ubuntu mirror inventory changed; inspect before selecting archives")
mirrors.write_text("\n".join(
    f"{line.split()[0]}\tpriority:{priorities[line.split()[0]]}"
    if line.split() and line.split()[0] in priorities else line
    for line in lines
) + "\n")
PY
fi
sudo tee /etc/apt/apt.conf.d/80jobctrl-ci-transport > /dev/null <<'CONFIG'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "2";
CONFIG
