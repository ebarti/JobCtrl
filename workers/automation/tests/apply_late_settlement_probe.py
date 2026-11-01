"""Owned cross-runtime fixture: actual claim/saga/sender/Skip/settlement/projection.

Invoked by the API regression with the prepared project interpreter. External
transports are fake; the canonical SQLite writers and projection are real.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from jobctrl import config, database
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from tests.test_exact_v7_apply_acquire_job_identity import (
    LOCAL_JOB_ID,
    test_owned_email_skip_overlap_retains_durable_authority,
)


def main():
    directory = Path(sys.argv[1]).resolve()
    mode = sys.argv[2]
    if mode not in {'after_intent', 'lost_ack', 'before_intent'}:
        raise ValueError('unknown owned probe mode')
    if (directory / 'owned-probe').read_text() != 'synthetic apply 1173':
        raise ValueError('owned synthetic workspace required')
    path = directory / 'jobctrl.db'
    if path.exists():
        raise ValueError('probe refuses existing database')
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(config, 'APP_DIR', directory)
        patch.setattr(config, 'DB_PATH', path)
        patch.setattr(database, 'DB_PATH', path)
        conn = database.init_db(path)
        try:
            test_owned_email_skip_overlap_retains_durable_authority(conn, patch, directory, mode)
            ProjectionBuilder(conn_factory=lambda: conn).refresh()
            runs = [dict(r) for r in conn.execute('SELECT run_id,status,result FROM apply_run_projections')]
            print(json.dumps({'job_id': LOCAL_JOB_ID, 'runs': runs,
                              'events': [dict(r) for r in conn.execute("SELECT event_type,payload_json FROM job_events WHERE stage='apply' ORDER BY event_id")] }))
        finally:
            database.close_connection(path)


if __name__ == '__main__':
    main()
