"""Pause an owned predecessor worker at an exact durable external-call gap.

Pdb observes the unmodified production code. It never changes locals, return
values, dispatch, model results or database rows. The journey then kills this
actual paused worker and upgrades the same public-created workspace.
"""

import json
import os
from pathlib import Path
import pdb
import signal
import sys

import jobctrl
from jobctrl.app.worker import main

arm = Path(sys.argv[1])
paused = Path(sys.argv[2])
sys.argv = ["jobctrl.app.worker", *sys.argv[3:]]
target = Path(jobctrl.__file__).parent / "features/fit/refresh.py"
lines = target.read_text().splitlines()
matches = [index + 1 for index, line in enumerate(lines) if line.strip() == "return SimpleNamespace(**value)"]
if len(matches) != 1:
    raise RuntimeError("The exact predecessor external-call return is ambiguous")
line_number = matches[0]


class DurableGap(pdb.Pdb):
    def user_line(self, frame):
        if frame.f_code.co_filename == str(target) and frame.f_lineno == line_number and arm.exists():
            requested = arm.read_text()
            operation = frame.f_locals.get("arguments", {}).get("operation")
            if requested == operation:
                arm.unlink()
                paused.write_text(json.dumps({"operation": operation, "pid": os.getpid(), "line": line_number}))
                os.kill(os.getpid(), signal.SIGSTOP)
        self.set_continue()


debugger = DurableGap(nosigint=True, readrc=False)
error = debugger.set_break(str(target), line_number)
if error:
    raise RuntimeError(error)
debugger.runcall(main)
