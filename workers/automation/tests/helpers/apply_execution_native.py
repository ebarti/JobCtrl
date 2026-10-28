"""Actual fixed native Apply dispatch QA with owned preflight executables only.

MODE WORKER_SOURCE APP_DIR EVIDENCE_DIR. Go supplies the authenticated compiled
local payload and selector. No accounts, providers, network or real application
submission are used. The adopted version executable deliberately leaves an owned
setsid writer in the dedicated Apply coalition, before any Chrome/agent birth.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import time

mode, source_arg, app_arg, evidence_arg = sys.argv[1:]
source = Path(source_arg)
sys.path.insert(0, str(source))
sys.path.insert(0, str(source.parent))
app, evidence = Path(app_arg).resolve(), Path(evidence_arg).resolve()
os.environ["JOBCTRL_DIR"] = str(app)
if mode == "seed":
    os.environ["JOBCTRL_RUNTIME_MODE"] = "source"
os.environ["LANGFUSE_DISABLE"] = "1"
os.environ["OTEL_SDK_DISABLED"] = "true"
evidence.mkdir(parents=True, exist_ok=True)

if mode == "writer":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    identity = os.environ["JOBCTRL_APPLY_EXECUTION_SCOPE"]
    (evidence / f"writer-{identity}.json").write_text(json.dumps({"pid": os.getpid(), "sid": os.getsid(0)}))
    while True:
        (evidence / f"ticks-{identity}").write_text(str(time.monotonic()))
        time.sleep(.01)

from jobctrl import config, database  # noqa: E402
from jobctrl.apply.execution import ScopedApplyExecution  # noqa: E402
from jobctrl.browser_capabilities import enable_system_browser_capability  # noqa: E402

config.ensure_dirs()
if mode == "seed":
    from tests.test_apply_regressions import _insert_ready_job
    conn = database.init_db()
    job = _insert_ready_job(conn, url="https://example.com/owned-native-manual",
                            application_url="https://ibegin.tcsapps.com/owned-synthetic-only")
    executable = evidence / "owned-version-browser"
    executable.write_text(f'''#!{sys.executable}
import os,subprocess,sys,time
from pathlib import Path
if sys.argv[1:] != ['--version']: raise SystemExit('QA never opens a browser')
identity=os.environ.get('JOBCTRL_APPLY_EXECUTION_SCOPE')
if identity:
 subprocess.Popen([sys.executable,{str(Path(__file__).resolve())!r},'writer',{str(source)!r},{str(app)!r},{str(evidence)!r}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 ready=Path({str(evidence)!r})/('writer-'+identity+'.json')
 deadline=time.monotonic()+10
 while not ready.exists():
  if time.monotonic()>deadline: raise RuntimeError('owned writer missing')
  time.sleep(.01)
print('Chromium synthetic readiness fixture')
''')
    executable.chmod(0o700)
    enable_system_browser_capability("auto-apply-browser", executable, app_dir=app)
    (evidence / "job-id").write_text(str(job))
    database.close_thread_connections()

if mode == "run":
    job = (evidence / "job-id").read_text()
    requests = []
    for dry_run in (True, False):
        invocation = ScopedApplyExecution()
        result = invocation.run(dict(limit=1, target_job_id=job, tenant_id="local", min_score=7,
            headless=True, model="default", dry_run=dry_run, continuous=False,
            poll_interval=60, workers=1, approval_required=False, workflow_id="synthetic-native-apply"))
        if result != (0, 0):
            raise RuntimeError("manual boundary returned unexpected counts")
        result_path = app / "apply-invocations" / invocation.identity / "result.json"
        value = json.loads(result_path.read_text())
        scope = value["native_custody"]["scope"]["id"]
        if not (evidence / f"writer-{scope}.json").exists():
            raise RuntimeError("fixed module did not execute its preflight inside the dedicated scope")
        requests.append({"request_id": invocation.identity, "scope_id": scope})
    conn = database.get_connection()
    count = conn.execute("SELECT count(*) FROM job_events WHERE job_id=? AND event_type='ApplyManualSkip'", (job,)).fetchone()[0]
    if count != 2:
        raise RuntimeError("same-job second native Apply did not reach its real manual boundary")
    (evidence / "fixed-module-results.json").write_text(json.dumps(requests))
    database.close_thread_connections()
