"""Pause the first owned worker at the durable search step's handoff to its timer."""

import json
import os
from pathlib import Path
import signal
import sys

from dbos import DBOS
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.app.worker import main
from jobctrl.app.worker_identity import STOP_TOPIC

paused = Path(sys.argv[1])
sys.argv = ["jobctrl.app.worker", *sys.argv[2:]]
workspace = Path(sys.argv[sys.argv.index("--workspace") + 1]).resolve(strict=True)
if synthetic_boundary(workspace) is None or paused.parent.resolve(strict=True) != workspace.parent:
    raise RuntimeError("The search timer debugger requires an owned synthetic workspace")


def before_receive(_code, _offset):
    if sys._getframe(1).f_locals.get("topic") == STOP_TOPIC:
        paused.write_text(json.dumps({"pid": os.getpid(), "workflowId": DBOS.workflow_id}))
        os.kill(os.getpid(), signal.SIGSTOP)


monitor = sys.monitoring
tool = monitor.DEBUGGER_ID
code = DBOS.recv_async.__func__.__code__
monitor.use_tool_id(tool, "jobctrl-search-timer")
monitor.register_callback(tool, monitor.events.PY_START, before_receive)
monitor.set_local_events(tool, code, monitor.events.PY_START)
try:
    main()
finally:
    monitor.set_local_events(tool, code, 0)
    monitor.free_tool_id(tool)
