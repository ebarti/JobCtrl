"""Check a stopped generation's file references without starting application writers."""

import csv
import json
from contextlib import nullcontext
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from jobctrl.app.postgres_upgrade_source import validate_artifacts


class Row(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)

    def __iter__(self):
        return iter(self.values())


class Result(list):
    def fetchone(self):
        return self[0] if self else None

    def fetchall(self):
        return self


class OfflinePostgres:
    def __init__(self, postgres, data, scratch):
        self.postgres = postgres
        self.data = data
        self.scratch = scratch

    def execute(self, query, params=()):
        from jobctrl.app.postgres_connection import _bind_qmarks
        from psycopg.sql import Literal
        if params:
            formatted, count = _bind_qmarks(query)
            if count != len(params):
                raise ValueError("Invalid offline SQL binding")
            query = formatted % tuple(Literal(value).as_string() for value in params)
        # Encode rows with names and native JSON scalar types for the same
        # feature readers that normally use a SQLAlchemy connection.
        query = f"SELECT row_to_json(item)::text FROM ({query}) AS item"
        # validate_artifacts owns the SELECT statements. Single-user mode opens
        # only this private staged generation and never starts DBOS or a socket.
        # A later SELECT in the same transaction proves that COPY completed.
        name = self.scratch / uuid4().hex
        token = uuid4().hex
        literal = "'" + str(name).replace("'", "''") + "'"
        sql = f"BEGIN READ ONLY\nCOPY ({query}) TO {literal} WITH (FORMAT CSV)\nSELECT '{token}'\nCOMMIT\n"
        result = subprocess.run(
            [self.postgres, "--single", "-D", self.data, "-c", "standard_conforming_strings=on", "jobctrl"],
            input=sql.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        if ('= "' + token + '"').encode() not in result.stdout:
            raise ValueError("Incomplete PostgreSQL artifact inventory")
        with name.open(newline="", encoding="utf-8") as rows:
            return Result(Row(json.loads(row[0])) for row in csv.reader(rows))


def workflow_compatible(connection, workspace):
    from jobctrl.app.database import Database, _catalog, _instance_id, _verify
    from jobctrl.app.postgres_workspace import read_marker, verify_physical
    from jobctrl.app.workflow_compat import inspect_offline

    cluster, oid, metadata = _catalog(connection)
    oid = int(oid)  # PostgreSQL JSON represents oid as text.
    marker, state = _verify(workspace, read_marker(workspace), metadata)
    verify_physical(marker, cluster, oid)
    if state != "active" or marker["pending_target"] is not None:
        raise ValueError("Not an active workspace")
    class ColdDatabase:
        read_only = True
        initialize_feature = Database.initialize_feature

        def connect(self):
            return nullcontext(connection)

        def close(self):
            pass

    database = ColdDatabase()
    database.workspace = workspace
    database.workspace_id = marker["workspace_id"]
    database.instance_id = _instance_id(workspace, marker, oid)
    features = os.environ.get("JOBCTRL_FEATURES")
    result = inspect_offline(workspace, database, enabled_features=features.split(",") if features else None)
    if not result["compatible"]:
        raise ValueError("Pending work is incompatible")


def main():
    postgres, data, workspace, operation = sys.argv[1:]
    csv.field_size_limit(sys.maxsize)
    with tempfile.TemporaryDirectory(prefix="jobctrl-pg-file-proof-") as directory:
        database = OfflinePostgres(postgres, data, Path(directory))
        if operation == "workflows":
            workflow_compatible(database, Path(workspace))
            return
        validate_artifacts(database, {"resumes_documents"}, Path(workspace))
        if list(database.execute(
            "SELECT 1 FROM resumes_artifact_retirements WHERE status IN ('rendering','retiring','pending') LIMIT 1"
        )):
            raise ValueError("Unresolved PDF retirement")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # The database and filesystem can contain private resume content.
        os._exit(1)
