"""Pause the owned worker after a real model settlement, before its caller receives the result."""

import inspect
import json
import os
from pathlib import Path
import signal
import sys

from jobctrl.app.model import ModelGateway
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.app.worker import main

arm = Path(sys.argv[1])
paused = Path(sys.argv[2])
sys.argv = ["jobctrl.app.worker", *sys.argv[3:]]
workspace = Path(sys.argv[sys.argv.index("--workspace") + 1]).resolve(strict=True)
if (synthetic_boundary(workspace) is None
        or arm.parent.resolve(strict=True) != workspace.parent
        or paused.parent.resolve(strict=True) != workspace.parent):
    raise RuntimeError("The model receipt debugger requires an owned synthetic workspace")
model_source, first_line = inspect.getsourcelines(ModelGateway.determine)
matches = [first_line + offset for offset, line in enumerate(model_source)
           if line.strip() == "return self._recorded_result(self.receipt(receipt_id))"]
if len(matches) != 1:
    raise RuntimeError("The model settlement observation line is ambiguous")
settled_line = matches[0]
monitor = sys.monitoring
tool = monitor.DEBUGGER_ID


def observe_settlement(_code, line):
    if line != settled_line or not arm.exists():
        return
    frame = sys._getframe(1)
    if frame.f_locals["operation"] != "fit.qualification-batch":
        return
    arm.unlink()
    paused.write_text(json.dumps({"pid": os.getpid(), "receiptId": frame.f_locals["receipt_id"]}))
    os.kill(os.getpid(), signal.SIGSTOP)


# Local LINE events observe the production method on DBOS's execution loop
# without tracing every import or skipping callbacks on other threads.
monitor.use_tool_id(tool, "jobctrl-model-receipt")
monitor.register_callback(tool, monitor.events.LINE, observe_settlement)
monitor.set_local_events(tool, ModelGateway.determine.__code__, monitor.events.LINE)
try:
    main()
finally:
    monitor.set_local_events(tool, ModelGateway.determine.__code__, 0)
    monitor.free_tool_id(tool)
