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

# Evidence only: keep the existing APT installation path and its failures.
if ! timeout --kill-after=1s 25s python3 -I - <<'PY'
import concurrent.futures
import json
import os
import shlex
import subprocess
import sys
import threading

report_lock = threading.Lock()

def report(kind, **values):
    with report_lock:
        print("APT diagnostics: " + json.dumps({"kind": kind, **values}, sort_keys=True), flush=True)


archives = (
    ("archive.ubuntu.com", "https://archive.ubuntu.com/ubuntu/dists/noble/InRelease"),
    ("security.ubuntu.com", "https://security.ubuntu.com/ubuntu/dists/noble/InRelease"),
    ("azure.archive.ubuntu.com", "http://azure.archive.ubuntu.com/ubuntu/dists/noble/InRelease"),
)
transport = {
    "HTTP_TIMEOUT": "Acquire::http::Timeout",
    "HTTPS_TIMEOUT": "Acquire::https::Timeout",
    "RETRIES": "Acquire::Retries",
    "IPV4": "Acquire::ForceIPv4",
    "IPV6": "Acquire::ForceIPv6",
}
proxy_keys = {
    "APT_HTTP_PROXY": "Acquire::http::Proxy",
    "APT_HTTPS_PROXY": "Acquire::https::Proxy",
    "APT_HTTP_PROXY_AUTO": "Acquire::http::Proxy-Auto-Detect",
    "APT_HTTPS_PROXY_AUTO": "Acquire::https::Proxy-Auto-Detect",
}
query = ["sudo", "-n", "apt-config", "shell"]
for alias, key in (transport | proxy_keys).items():
    query.extend((alias, key))
try:
    config = subprocess.run(query, capture_output=True, text=True, timeout=3, check=False)
    values = dict(token.split("=", 1) for token in shlex.split(config.stdout) if "=" in token)
    report("effective_transport", exit_code=config.returncode, values={
        key: (values[alias] if values.get(alias, "").isdigit()
              or values.get(alias) in ("true", "false") else "set; value withheld")
        if alias in values else "unset"
        for alias, key in transport.items()
    })
    report("apt_proxy_presence", values={key: alias in values for alias, key in proxy_keys.items()})
except (OSError, subprocess.SubprocessError, ValueError):
    report("effective_transport", error="configuration query unavailable or timed out")
report("runner_proxy_presence", values={
    name: name in os.environ
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                 "http_proxy", "https_proxy", "all_proxy", "no_proxy")
})

dns_code = """
import json, os, socket, sys
try:
    rows = socket.getaddrinfo(sys.argv[1], None, type=socket.SOCK_STREAM)
    print(json.dumps({"status": "resolved", "uid": os.geteuid(),
        "families": sorted({int(row[0]) for row in rows}), "addresses": len({row[4][0] for row in rows})}))
except OSError as error:
    print(json.dumps({"status": "resolution_failed", "uid": os.geteuid(), "errno": error.errno}))
"""


def dns(host, identity):
    command = ["timeout", "--signal=KILL", "5s", sys.executable, "-I", "-c", dns_code, host]
    if identity == "_apt":
        command = ["sudo", "-n", "-u", "_apt", "--", *command]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=7, check=False)
        outcome = json.loads(result.stdout) if result.returncode == 0 else {
            "status": "timeout" if result.returncode in (124, 137) else "identity_or_probe_unavailable",
            "exit_code": result.returncode,
        }
        report("dns", host=host, identity=identity, **outcome)
    except (OSError, subprocess.SubprocessError, ValueError):
        report("dns", host=host, identity=identity, status="probe_unavailable_or_timed_out")


def http(host, url):
    try:
        result = subprocess.run([
            "curl", "--disable", "--silent", "--connect-timeout", "5", "--max-time", "8",
            "--retry", "0", "--output", os.devnull, "--proto", "=http,https", "--write-out",
            "%{http_code} %{time_namelookup} %{time_connect} %{time_total}", url,
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=9, check=False)
        fields = result.stdout.split()
        metrics = {"http_status": int(fields[0]), "dns_seconds": float(fields[1]),
                   "connect_seconds": float(fields[2]), "total_seconds": float(fields[3])}
        # Never echo curl stderr: malformed proxy errors can contain credentials.
        error = {0: "none", 5: "proxy_resolution_failed", 6: "host_resolution_failed",
                 7: "connection_failed", 28: "timeout", 35: "tls_handshake_failed",
                 60: "tls_verification_failed"}.get(result.returncode, "curl_failed")
        report("http_get", host=host, url=url, identity="runner", exit_code=result.returncode,
               error=error, **metrics)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        report("http_get", host=host, identity="runner", error="probe_unavailable_or_timed_out")


with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
    futures = []
    for host, url in archives:
        futures.extend(pool.submit(dns, host, identity) for identity in ("runner", "_apt"))
        futures.append(pool.submit(http, host, url))
    for future in concurrent.futures.as_completed(futures):
        future.result()
report("complete")
PY
then
  echo 'APT diagnostics did not complete; continuing with the existing package installation.' >&2
fi
