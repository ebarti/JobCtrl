"""Check a stopped generation's file references without starting application writers."""

import csv
import hashlib
import json
from contextlib import nullcontext
from importlib import import_module
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from jobctrl.app.postgres_upgrade_source import validate_artifacts
from jobctrl.app.postgres_upgrade_schema import FEATURE_SCHEMAS


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


def installed_owners(connection, names):
    registered = dict(connection.execute("SELECT name,digest FROM public.app_feature_schemas"))
    relations = dict(connection.execute(
        "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n "
        "ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')"
    ))
    owners = set()
    for name in names:
        observed = {table for table in relations if table.startswith(name + "_")}
        if not observed and name not in registered:
            continue
        module, symbol = next((module, symbol) for feature, module, symbol in FEATURE_SCHEMAS if feature == name)
        schema = getattr(import_module("jobctrl." + module), symbol)
        declared = set(re.findall(r"(?im)^\s*CREATE TABLE (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)\b", schema))
        if (not declared or declared != observed or any(relations[t] not in ("r", "p") for t in observed)
                or registered.get(name) != hashlib.sha256(schema.encode()).hexdigest()):
            raise ValueError("Incomplete optional feature schema")
        owners.add(name)
    return owners


def effect_fingerprint(connection):
    owners = installed_owners(connection, ("applications", "extension", "outreach", "resumes"))
    tables = ["app_model_calls"]
    guards = [
        "SELECT 1 FROM public.app_model_calls WHERE (provider_started IS NULL OR provider_started<>0) AND "
        "(status IN ('running','uncertain') OR cost_usd IS NULL OR input_tokens IS NULL "
        "OR output_tokens IS NULL OR cost_source IS NULL)",
        "SELECT 1 FROM public.app_action_runs WHERE status IN ('pending','queued','running','start_failed')",
        "SELECT 1 FROM dbos.workflow_status WHERE status NOT IN "
        "('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')",
    ]
    if "applications" in owners:
        tables.extend(("applications_state", "applications_payloads", "applications_decisions", "applications_runs",
                       "applications_repeat_overrides", "applications_submit_intents", "applications_submit_receipts"))
        guards.append("SELECT 1 FROM public.applications_submit_intents i "
                      "LEFT JOIN public.applications_submit_receipts r USING(tenant_id,intent_id) WHERE r.intent_id IS NULL")
    if "extension" in owners:
        tables.extend(("extension_browser_tasks", "extension_capture_receipts"))
        guards.extend(("SELECT 1 FROM public.extension_browser_tasks WHERE state NOT IN ('succeeded','failed')",
                       "SELECT 1 FROM public.extension_capture_receipts WHERE state='importing'"))
    if "outreach" in owners:
        tables.append("outreach_action_receipts")
    rows = " UNION ALL ".join(
        f"SELECT '{table}:' || encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash "
        f"FROM public.{table} t" for table in tables
    )
    result = connection.execute(
        "SELECT encode(sha256(convert_to(COALESCE(string_agg(hash,'' ORDER BY hash),''),'UTF8')),'hex') AS digest "
        f"FROM ({rows}) effects HAVING " + " AND ".join(f"NOT EXISTS ({query})" for query in guards)
    ).fetchone()
    if not result:
        raise ValueError("Unsettled external effects")
    print(result[0], flush=True)


def main():
    postgres, data, workspace, operation = sys.argv[1:]
    csv.field_size_limit(sys.maxsize)
    if operation == "effects-live":
        import psycopg
        with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"]) as connection:
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            effect_fingerprint(connection)
        return
    with tempfile.TemporaryDirectory(prefix="jobctrl-pg-file-proof-") as directory:
        database = OfflinePostgres(postgres, data, Path(directory))
        if operation == "workflows":
            workflow_compatible(database, Path(workspace))
            return
        if operation == "effects":
            effect_fingerprint(database)
            return
        if "resumes" not in installed_owners(database, ("resumes",)):
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
