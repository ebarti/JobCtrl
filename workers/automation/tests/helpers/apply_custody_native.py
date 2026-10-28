"""Private native QA harness; every path/process belongs to the test instance.

Run under a real native execution scope, never a user workspace. The Go test
owns scope setup/stop/restart and peer preservation. No provider/account/browser
or application data is used. Arguments: MODE WORKER_SOURCE APP_DIR EVIDENCE_DIR.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


mode, source, app_arg, evidence_arg = sys.argv[1:]
sys.path.insert(0, source)
app = Path(app_arg).resolve()
evidence = Path(evidence_arg)
evidence.mkdir(parents=True, exist_ok=True)
os.environ["JOBCTRL_DIR"] = str(app)
os.environ["LANGFUSE_DISABLE"] = "1"
os.environ["OTEL_SDK_DISABLED"] = "true"


def wait_file(path: Path) -> None:
    deadline = time.monotonic() + 15
    while not path.exists():
        if time.monotonic() > deadline:
            raise RuntimeError(f"owned native harness did not publish {path.name}")
        time.sleep(0.01)


if mode == "writer":
    # Spawned with setsid by target: escapes its Apply root/session but remains
    # inside the actual native execution coalition, which the Go stop owns.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (evidence / "writer-ready.json").write_text(json.dumps({"pid": os.getpid(), "sid": os.getsid(0)}))
    counter = 0
    while True:
        counter += 1
        (evidence / "writer-ticks").write_text(str(counter))
        time.sleep(0.01)

if mode == "target":
    subprocess.Popen([sys.executable, __file__, "writer", source, str(app), str(evidence)], start_new_session=True)
    wait_file(evidence / "writer-ready.json")
    os._exit(0)

from jobctrl import config  # noqa: E402
from jobctrl.apply import launcher, ownership  # noqa: E402

config.ensure_dirs()
if mode == "owner":
    run = ownership.ApplyLauncherRun()
    with run.lease():
        run.allocate_workers(1)
        ownership.spawn_owned_apply_process(
            run.worker_ids[0], "browser", [sys.executable, __file__, "target", source, str(app), str(evidence)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        wait_file(evidence / "writer-ready.json")
        journal_path = run._journal.path
        (evidence / "journal-path").write_text(str(journal_path))
        journal = json.loads(journal_path.read_text())
        if not journal["native_custody"]:
            raise RuntimeError("real native scope binding was not captured")
        (evidence / "owner-bound.json").write_text(json.dumps(journal["native_custody"]))
        os._exit(71)

if mode == "hold":
    owner = subprocess.Popen([sys.executable, __file__, "owner", source, str(app), str(evidence)])
    if owner.wait(timeout=20) != 71:
        raise RuntimeError("owned Apply owner did not reach its abrupt-death boundary")
    wait_file(evidence / "owner-bound.json")
    (evidence / "hold-ready").write_text(str(os.getpid()))
    while True:
        time.sleep(0.1)

if mode in {"refuse", "recover"}:
    from jobctrl.apply.process_birth import retire_run_custody, CustodyUnverified
    journal_path = Path((evidence / "journal-path").read_text())
    before = journal_path.read_bytes()
    run_id = journal_path.parent.name
    called = []
    launcher._main = lambda **_kwargs: (called.append(True) or (0, 0))
    if mode == "refuse":
        try:
            retire_run_custody(app, run_id)
        except CustodyUnverified:
            if journal_path.read_bytes() != before:
                raise RuntimeError("refused retirement changed retained custody")
        else:
            raise RuntimeError("escaped writer retired without native completion")
        if launcher.main(install_signal_handlers=False) != (0, 0) or called != [True]:
            raise RuntimeError("unrelated per-run peer was not independently admitted")
        if journal_path.read_bytes() != before:
            raise RuntimeError("peer admission modified predecessor custody")
        (evidence / "refused").write_text("specific custody retained; unrelated peer admitted")
    else:
        retire_run_custody(app, run_id)
        if journal_path.exists():
            raise RuntimeError("exact native completion did not retire selected custody")
        if launcher.main(install_signal_handlers=False) != (0, 0) or called != [True]:
            raise RuntimeError("normal native restart failed")
        (evidence / "recovered").write_text("real native completion consumed")
