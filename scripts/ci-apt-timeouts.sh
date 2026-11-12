#!/usr/bin/env bash
set -euo pipefail

# Hosted browser setup must not spend the entire job waiting for a stale mirror.
# Keep the runner's repositories, signing keys and package verification intact.
if [[ "${CI:-}" != true || "${RUNNER_OS:-}" != Linux || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'APT transport configuration requires a GitHub-hosted Linux job.' >&2
  exit 1
fi
# When the image lists these three Ubuntu archives, prefer its HTTPS
# alternatives: a continuously slow Azure download never trips an idle timeout.
# Keep the same repositories, suites, signing keys and package verification.
if [[ -f /etc/apt/apt-mirrors.txt && ! -L /etc/apt/apt-mirrors.txt ]]; then
  sudo python3 - <<'PY'
import json
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
    # Reordering is optional. A missing required URL permits neither a rewrite
    # nor promotion; normal APT still verifies the runner's unchanged sources.
    print("APT diagnostics: " + json.dumps({
        "kind": "mirror_priority", "decision": "keep_existing",
        "reason": "required_original_urls_absent",
    }, sort_keys=True), flush=True)
else:
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

# Admit only the fixed HTTPS fallback after the existing archive probes fail.
# APT still verifies signatures, package hashes and archive freshness.
if ! timeout --kill-after=1s 25s python3 -I - <<'PY'
import concurrent.futures
import json
import math
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
            "status": "timeout" if result.returncode in (-9, 124, 137) else "identity_or_probe_unavailable",
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
        if len(fields) != 4 or not fields[0].isdigit():
            raise ValueError("Unrecognized probe metrics")
        metrics = {"http_status": int(fields[0]), "dns_seconds": float(fields[1]),
                   "connect_seconds": float(fields[2]), "total_seconds": float(fields[3])}
        if not 0 <= metrics["http_status"] <= 599 or any(
            not math.isfinite(metrics[key]) or metrics[key] < 0
            for key in ("dns_seconds", "connect_seconds", "total_seconds")
        ):
            raise ValueError("Unrecognized probe metrics")
        # Never echo curl stderr: malformed proxy errors can contain credentials.
        error = {0: "none", 5: "proxy_resolution_failed", 6: "host_resolution_failed",
                 7: "connection_failed", 28: "timeout", 35: "tls_handshake_failed",
                 60: "tls_verification_failed"}.get(result.returncode, "curl_failed")
        state = "usable" if result.returncode == 0 and 200 <= metrics["http_status"] < 400 else (
            "failed" if result.returncode != 0 or metrics["http_status"] >= 400 else "indeterminate"
        )
        outcome = {"exit_code": result.returncode, "error": error, "state": state, **metrics}
        report("http_get", host=host, url=url, identity="runner", **outcome)
        return outcome
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        report("http_get", host=host, identity="runner", error="probe_unavailable_or_timed_out")
        return {"state": "indeterminate"}


# No remote content or selected URL is passed to this privileged append.
append_fallback = """
import os, stat
path = "/etc/apt/apt-mirrors.txt"
originals = {"https://archive.ubuntu.com/ubuntu/", "https://security.ubuntu.com/ubuntu/",
             "http://azure.archive.ubuntu.com/ubuntu/"}
fallback = "https://mirrors.edge.kernel.org/ubuntu/"
row = b"https://mirrors.edge.kernel.org/ubuntu/\\tpriority:0\\n"
fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
try:
    identity = os.fstat(fd)
    if not stat.S_ISREG(identity.st_mode) or identity.st_size > 65536:
        raise SystemExit(2)
    data = os.read(fd, 65537)
    if len(data) > 65536 or (data and not data.endswith(b"\\n")):
        raise SystemExit(2)
    present = {line.split()[0] for line in data.decode("utf-8").splitlines()
               if line.strip() and not line.lstrip().startswith("#")}
    if not originals <= present:
        raise SystemExit(2)
    current = os.stat(path, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
        raise SystemExit(2)
    if fallback in present:
        if row.rstrip(b"\\n") not in data.splitlines():
            raise SystemExit(2)
        print("already_present")
    else:
        if os.write(fd, row) != len(row):
            raise SystemExit(2)
        os.fsync(fd)
        print("appended")
finally:
    os.close(fd)
"""


with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
    futures = []
    http_futures = []
    for host, url in archives:
        futures.extend(pool.submit(dns, host, identity) for identity in ("runner", "_apt"))
        request = pool.submit(http, host, url)
        http_futures.append(request)
        futures.append(request)
    for future in concurrent.futures.as_completed(futures):
        future.result()
original_results = [future.result() for future in http_futures]
if len(original_results) == 3 and all(result["state"] == "failed" for result in original_results):
    candidate = http("mirrors.edge.kernel.org", "https://mirrors.edge.kernel.org/ubuntu/dists/noble/InRelease")
    if candidate.get("exit_code") == 0 and candidate.get("http_status") == 200:
        try:
            added = subprocess.run(["sudo", "-n", "timeout", "--signal=KILL", "2s",
                                    sys.executable, "-I", "-c", append_fallback],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, timeout=3, check=False)
            decision = added.stdout.strip()
            if added.returncode == 0 and decision in ("appended", "already_present"):
                report("mirror_decision", decision=decision, mirror="https://mirrors.edge.kernel.org/ubuntu/",
                       reason="all_existing_http_probes_failed_and_fallback_http_200")
            else:
                report("mirror_decision", decision="append_refused", exit_code=added.returncode)
        except (OSError, subprocess.SubprocessError):
            report("mirror_decision", decision="append_unavailable_or_timed_out")
    else:
        report("mirror_decision", decision="keep_existing", reason="fallback_not_http_200")
else:
    report("mirror_decision", decision="keep_existing", reason="existing_usable_or_probe_indeterminate")
report("complete")
PY
then
  echo 'APT archive preflight did not complete; continuing with the existing package installation.' >&2
fi
