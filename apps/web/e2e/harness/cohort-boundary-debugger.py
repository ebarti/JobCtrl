"""Observe the owned worker immediately before its real final Fit guard.

The debugger changes no application locals, decisions, returns or database
rows. A public-API journey may change a posting while this process is stopped,
then resume the actual worker and observe its ordinary currentness guard.
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
target = Path(jobctrl.__file__).parent / "app/preparation.py"
matches = [index + 1 for index, line in enumerate(target.read_text().splitlines())
           if line.strip() == "return self.checkpoints.settle_search(context.run_id, failed,"]
if len(matches) != 1:
    raise RuntimeError("The cohort final currentness guard is ambiguous")
line_number = matches[0]


class CohortBoundary(pdb.Pdb):
    def user_line(self, frame):
        if frame.f_code.co_filename == str(target) and frame.f_lineno == line_number and arm.exists():
            arm.unlink()
            paused.write_text(json.dumps({"pid": os.getpid(), "line": line_number}))
            os.kill(os.getpid(), signal.SIGSTOP)
        self.set_continue()


debugger = CohortBoundary(nosigint=True, readrc=False)
error = debugger.set_break(str(target), line_number)
if error:
    raise RuntimeError(error)
debugger.runcall(main)
