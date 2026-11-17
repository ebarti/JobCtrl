"""Observe the owned worker at selected real cohort durability boundaries.

The debugger changes no application locals, decisions, returns or database
rows. Journeys can change a source before the real final currentness guard, or
restart the worker after a gateway receipt settles but before its checkpoint.
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
root = Path(jobctrl.__file__).parent
guard_target = root / "app/preparation.py"
guard_matches = [index + 1 for index, line in enumerate(guard_target.read_text().splitlines())
                 if line.strip() == "return self.checkpoints.settle_search(context.run_id, failed,"]
if len(guard_matches) != 1:
    raise RuntimeError("The cohort final currentness guard is ambiguous")
receipt_target = root / "features/fit/cohort.py"
receipt_matches = [index + 1 for index, line in enumerate(receipt_target.read_text().splitlines())
                   if line.strip() == "self.service.store.complete_initial_cohort_call(self.operation_id, raw)"]
if len(receipt_matches) != 2:
    raise RuntimeError("The fresh cohort receipt checkpoint is ambiguous")
boundaries = {
    (str(guard_target), guard_matches[0]): "final-currentness-guard",
    (str(receipt_target), receipt_matches[-1]): "fit-receipt",
}


class CohortBoundary(pdb.Pdb):
    def user_line(self, frame):
        boundary = boundaries.get((frame.f_code.co_filename, frame.f_lineno))
        if boundary and arm.exists() and arm.read_text() == boundary:
            arm.unlink()
            paused.write_text(json.dumps({"pid": os.getpid(), "line": frame.f_lineno, "boundary": boundary}))
            os.kill(os.getpid(), signal.SIGSTOP)
        self.set_continue()


debugger = CohortBoundary(nosigint=True, readrc=False)
for target, line_number in boundaries:
    error = debugger.set_break(target, line_number)
    if error:
        raise RuntimeError(error)
debugger.runcall(main)
