"""Import the current Python SQLite workspace into an explicitly selected local PostgreSQL stage."""

from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import closing, nullcontext
from dataclasses import dataclass
from graphlib import TopologicalSorter
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import stat
import sys

from jobctrl.app.errors import AppError
from jobctrl.app.postgres_upgrade_schema import initialize_target
from jobctrl.app.postgres_upgrade_source import (
    UpgradeError, admit_schema, canonical, check_ownership, exclude_source_writers, external_state, fingerprint, quoted,
    require, snapshot, validate_artifacts, validate_attachments,
)

CONTROL_TABLES = {"app_metadata", "app_feature_schemas"}
SEED_ROWS = {"requirements_catalog": [(1, 0, 0)], "compensation_policy_revision": [(1, 0)]}
IMPORT_TABLE = "app_sqlite_import_receipt"


@dataclass(frozen=True)
class Table:
    name: str
    columns: tuple[str, ...]
    order_column: str | None
    identities: tuple[str, ...]

    def source_rows(self, source):
        fields = [quoted(column) for column in self.columns]
        if self.order_column:
            fields.append("rowid")
        return source.execute(f"SELECT {','.join(fields)} FROM {quoted(self.name)}")

    @property
    def fields(self):
        names = (*self.columns, self.order_column) if self.order_column else self.columns
        return ",".join(quoted(name) for name in names)


def data_digest(rows, write=None):
    # SQL engines may choose different scan orders and collations. Hash a typed,
    # length-delimited row, then sort fixed-size hashes, preserving multiplicity.
    hashes = []
    for row in rows:
        digest = hashlib.sha256()
        for value in row:
            if value is None:
                tag, data = b"N", b""
            elif type(value) is int:
                tag, data = b"I", struct.pack(">q", value)
            elif type(value) is float:
                tag, data = b"R", struct.pack(">d", value)
            elif isinstance(value, str):
                tag, data = b"T", value.encode()
            elif isinstance(value, (bytes, memoryview)):
                tag, data = b"B", bytes(value)
            else:
                raise UpgradeError("unsupported_database_value")
            digest.update(tag + struct.pack(">Q", len(data)))
            digest.update(data)
        hashes.append(digest.digest())
        if write is not None:
            write(row)
    digest = hashlib.sha256()
    for item in sorted(hashes):
        digest.update(item)
    return {"rows": len(hashes), "sha256": digest.hexdigest()}


def add_preserved_columns(conn, additions):
    from psycopg import sql

    types = {"TEXT": "TEXT", "INTEGER": "BIGINT", "BLOB": "BYTEA", "REAL": "DOUBLE PRECISION"}
    candidate = conn.sa_connection.connection.driver_connection
    for table, columns in additions.items():
        existing = {row[0] for row in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?", (table,))}
        for name, detail in reversed(columns.items()):
            require(name not in existing, f"added_column_collides_with_target:{table}")
            default = sql.SQL(" DEFAULT {}").format(sql.Literal(detail["default"])) if detail["default"] is not None else sql.SQL("")
            query = sql.SQL("ALTER TABLE public.{} ADD COLUMN {} {}{}{}").format(
                sql.Identifier(table), sql.Identifier(name), sql.SQL(types[detail["type"]]), default,
                sql.SQL(" NOT NULL" if detail["required"] else ""))
            with candidate.cursor() as cursor:
                cursor.execute(query)


def verify_keys(source, conn, tables):
    from sqlalchemy import inspect

    inspector = inspect(conn.sa_connection)
    keys = inspector.get_multi_pk_constraint(schema="public", filter_names=sorted(tables))
    foreign = inspector.get_multi_foreign_keys(schema="public", filter_names=sorted(tables))
    for name in tables:
        info = source.execute(f"PRAGMA table_info({quoted(name)})").fetchall()
        pk = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
        if name != "requirements_retrieval":
            require(pk == keys["public", name]["constrained_columns"], f"primary_key_mismatch:{name}")
        # The FTS5 logical documents gain a native composite primary key on
        # PostgreSQL. Content equality still includes every original row.
        predecessors = defaultdict(list)
        for row in source.execute(f"PRAGMA foreign_key_list({quoted(name)})"):
            predecessors[row[0]].append(row)
        expected = set()
        for group in predecessors.values():
            rows = sorted(group, key=lambda row: row[1])
            expected.add((rows[0][2], tuple(row[3] for row in rows), tuple(row[4] for row in rows),
                          rows[0][5], rows[0][6]))
        actual = set()
        for fk in foreign["public", name]:
            options = fk.get("options") or {}
            actual.add((fk["referred_table"], tuple(fk["constrained_columns"]), tuple(fk["referred_columns"]),
                        options.get("onupdate", "NO ACTION"), options.get("ondelete", "NO ACTION")))
        require(expected <= actual, f"foreign_key_mismatch:{name}")


def layouts(source, conn, tables):
    target = defaultdict(dict)
    for table, name, identity, generated in conn.execute(
            "SELECT table_name,column_name,is_identity,is_generated FROM information_schema.columns "
            "WHERE table_schema='public' ORDER BY table_name,ordinal_position"):
        target[table][name] = (identity == "YES", generated == "ALWAYS")
    verify_keys(source, conn, tables - CONTROL_TABLES)
    mappings = {}
    for name in sorted(tables - CONTROL_TABLES):
        require(name in target, f"missing_target_table:{name}")
        columns = tuple(row[1] for row in source.execute(f"PRAGMA table_info({quoted(name)})"))
        require(set(columns) <= target[name].keys(), f"missing_target_columns:{name}")
        identities = tuple(col for col, (identity, _) in target[name].items() if identity)
        order = [col for col in identities if col not in columns]
        require(len(order) <= 1 and all(col in {"storage_order", "insertion_order"} for col in order),
                f"unhandled_target_identity:{name}")
        mappings[name] = Table(name, columns, order[0] if order else None, identities)
    edges = {name: set() for name in mappings}
    for child, parent in conn.execute(
            "SELECT child.relname,parent.relname FROM pg_constraint k JOIN pg_class child ON child.oid=k.conrelid "
            "JOIN pg_class parent ON parent.oid=k.confrelid WHERE k.contype='f' "
            "AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace"):
        if child in edges and parent in edges:
            edges[child].add(parent)
    return [mappings[name] for name in TopologicalSorter(edges).static_order()], set(target)


def check_stage(conn, target_tables, *, populated=()):
    ignored = CONTROL_TABLES | set(populated)
    for table in sorted(target_tables - ignored):
        if table in SEED_ROWS:
            rows = [tuple(row) for row in conn.execute(f"SELECT * FROM {quoted(table)} LIMIT 2")]
            require(rows == SEED_ROWS[table], f"occupied_import_target:{table}")
        else:
            require(conn.execute(f"SELECT 1 FROM {quoted(table)} LIMIT 1").fetchone() is None,
                    f"occupied_import_target:{table}")
    require(conn.execute("SELECT to_regnamespace('dbos')").fetchone()[0] is None, "occupied_workflow_target")


def sequence_state(source):
    rows = source.execute("SELECT name,seq FROM sqlite_sequence").fetchall()
    require(all(isinstance(key, str) and type(value) is int and value >= 0 for key, value in rows)
            and len(dict(rows)) == len(rows), "invalid_source_identity_watermark")
    return dict(rows)


def verify_sequence(conn, table, column, expected):
    row = conn.execute("SELECT schemaname,sequencename FROM pg_sequences "
                       "WHERE format('%I.%I',schemaname,sequencename)::regclass=pg_get_serial_sequence(?,?)::regclass",
                       (table, column)).fetchone()
    require(row is not None and row[0] == "public", f"missing_target_sequence:{table}")
    seq = conn.execute(f"SELECT last_value,is_called FROM public.{quoted(row[1])}").fetchone()
    require(tuple(seq) == (expected, False), f"sequence_verification_failed:{table}")


def advance_identities(conn, table, watermarks):
    restarted = {}
    for column in table.identities:
        maximum = conn.execute(f"SELECT max({quoted(column)}) FROM {quoted(table.name)}").fetchone()[0]
        previous = watermarks.get(table.name, 0) if column in table.columns else 0
        next_id = max(maximum or 0, previous, 0) + 1
        require(next_id <= 9223372036854775807, f"identity_exhausted:{table.name}")
        # RESTART is transactional. A failed import cannot leak a sequence
        # change, unlike setval(), even after the final verification step.
        conn.execute(f"ALTER TABLE {quoted(table.name)} ALTER COLUMN {quoted(column)} RESTART WITH {next_id}")
        verify_sequence(conn, table.name, column, next_id)
        restarted[column] = next_id
    return restarted


def verify_table(conn, table):
    # A named server-side cursor bounds PG-side result buffering on large tables.
    raw = conn.sa_connection.connection.driver_connection
    with raw.cursor(name="jobctrl_migration_check") as cursor:
        cursor.execute(f"SELECT {table.fields} FROM public.{quoted(table.name)}")
        return data_digest(cursor)


def copy_data(source, conn, mappings, watermarks):
    result, identities = {}, {}
    require(watermarks.keys() <= {table.name for table in mappings}, "unowned_source_identity_watermark")
    raw = conn.sa_connection.connection.driver_connection
    for table in mappings:
        try:
            with raw.cursor() as cur, cur.copy(f"COPY public.{quoted(table.name)} ({table.fields}) FROM STDIN") as sink:
                result[table.name] = data_digest(table.source_rows(source), sink.write_row)
            require(verify_table(conn, table) == result[table.name], f"table_verification_failed:{table.name}")
            if table.identities:
                identities[table.name] = advance_identities(conn, table, watermarks)
            elif table.name in watermarks:
                raise UpgradeError(f"missing_target_sequence:{table.name}")
        except UpgradeError:
            raise
        except Exception:
            # Driver errors may contain a full row, private file path or SQL parameter.
            raise UpgradeError(f"table_copy_failed:{table.name}") from None
    return result, identities


def read_receipt(conn):
    if conn.execute("SELECT to_regclass('public.app_sqlite_import_receipt')").fetchone()[0] is None:
        return None
    rows = conn.execute(f"SELECT proof FROM {IMPORT_TABLE}").fetchall()
    require(len(rows) == 1, "invalid_import_receipt")
    return json.loads(rows[0][0])


def checkpoints(source, tables, original, conn, *, verify_only=False, source_only=False):
    if "discovery_units" in tables:
        from jobctrl.features.discovery.adapters.legacy_checkpoints import import_legacy_checkpoints
        if source_only:
            return import_legacy_checkpoints(source, original, None, source_only=True)
        return import_legacy_checkpoints(source, original, conn, verify_only=verify_only)
    require(not (original / "discovery-checkpoints").exists(), "unhandled_discovery_checkpoint_directory")
    return {}


def verify_original(path, source, mappings, base):
    # An offline backup can outlive its source or belong to a different
    # workspace. Activation requires current canonical state at the retained path.
    with snapshot(path) as retained:
        _, metadata, manifest, additions = admit_schema(retained)
        require((metadata, manifest, additions, sequence_state(retained)) ==
                (base["metadata"], base["feature_schemas"], base["added_columns"], base["source_sequences"]),
                "final_snapshot_stale_or_foreign")
        for table in mappings:
            require(data_digest(table.source_rows(retained)) == data_digest(table.source_rows(source)),
                    "final_snapshot_stale_or_foreign")


def import_workspace(sqlite_path, workspace, *, artifact_workspace=None, rehearse=False, seal_source=False, database_url=None):
    from jobctrl.app.database import Database

    workspace = Path(workspace).expanduser().absolute()
    sqlite_path = Path(sqlite_path).expanduser().absolute()
    if rehearse:
        require(not seal_source, "rehearsal_cannot_seal_source")
        require(artifact_workspace is not None or sqlite_path.name == "jobctrl.db", "artifact_workspace_required_for_backup")
    original = Path(artifact_workspace or (sqlite_path.parent if rehearse else workspace)).expanduser().resolve(strict=True)
    if rehearse:
        stage = workspace.resolve()
        require(not stage.is_relative_to(original) and not original.is_relative_to(stage) and
                stage != sqlite_path.parent.resolve(), "rehearsal_requires_separate_workspace")
        if workspace.exists():
            info = workspace.lstat()
            require(stat.S_ISDIR(info.st_mode) and (os.name == "nt" or
                    info.st_uid == os.getuid() and not info.st_mode & 0o077) and
                    {path.name for path in workspace.iterdir()} <= {".jobctrl-postgres-identity", ".jobctrl-database.lock"},
                    "rehearsal_requires_private_empty_or_staged_workspace")
        if (workspace / ".jobctrl-postgres-identity").exists():
            try:
                recorded = Database.probe(workspace, database_url=database_url)
            except AppError as error:
                if error.code != "database_initialization_incomplete":
                    raise
            else:
                require(recorded is not None and recorded["state"] == "staging", "rehearsal_target_already_active")
        writer_fence = nullcontext()
    else:
        require(original == workspace.resolve(), "activation_requires_original_workspace")
        original_database = original / "jobctrl.db"
        require(original_database.is_file(), "original_sqlite_binding_missing")
        if seal_source:
            from jobctrl.app.postgres_upgrade_seal import sealed_writer_fence
            writer_fence = sealed_writer_fence(original_database, database_url)
        else:
            writer_fence = exclude_source_writers(original_database)
    with writer_fence as held, snapshot(sqlite_path) as source:
        seal = held if seal_source else None
        tables, metadata, manifest, additions = admit_schema(source)
        check_ownership(source, tables, original)
        outstanding = external_state(source, tables)
        if not rehearse:
            for key in ("active_actions", "active_extension_tasks", "active_extension_captures", "unfinished_artifact_retirements"):
                require(not outstanding.get(key), f"predecessor_drain_required:{key}")
            # A running reservation may represent a live billing owner. Drain
            # it on the predecessor; already uncertain receipts remain exact.
            require(not outstanding["running_model_calls"], "predecessor_drain_required:running_model_calls")
        files = {"registered_pdfs": validate_artifacts(source, tables, original),
                 "profile_attachments": validate_attachments(source, tables)}
        base = {"version": 1, "workspace": str(original), "metadata": metadata, "feature_schemas": manifest,
                "added_columns": additions, "source_sequences": sequence_state(source), "external_state": outstanding, "files": files}
        # Staging=True refuses existing active targets. On a lost commit
        # acknowledgement, only a matching private source receipt permits success.
        try:
            database = Database(workspace, database_url=database_url, staging=True)
            active = False
        except AppError as error:
            if error.code != "database_already_active" or rehearse:
                raise
            database = Database(workspace, database_url=database_url)
            active = True
        with closing(database):
            if seal is not None:
                seal.bind(database.instance_id)
            if not active:
                initialize_target(database)
            with (database.connect() if active else database.transaction()) as conn:
                receipt = read_receipt(conn)
                require(not active or receipt is not None, "occupied_active_target")
                if receipt is None:
                    add_preserved_columns(conn, additions)
                mappings, target_tables = layouts(source, conn, tables)
                if not rehearse:
                    live_path = original / "jobctrl.db"
                    require(live_path.is_file(), "original_sqlite_binding_missing")
                    if not live_path.samefile(sqlite_path):
                        verify_original(live_path, source, mappings, base)

                if receipt is None:
                    check_stage(conn, target_tables)
                    for seed in SEED_ROWS.keys() & tables:
                        conn.execute(f"DELETE FROM {quoted(seed)}")
                    rows, sequences = copy_data(source, conn, mappings, base["source_sequences"])
                    checkpoint_proof = checkpoints(source, tables, original, conn)
                    conn.execute("SET CONSTRAINTS ALL IMMEDIATE")
                    proof = {**base, "tables": rows, "next_identities": sequences,
                             "checkpoints": checkpoint_proof, "database_id": database.instance_id}
                    conn.execute(f"CREATE TABLE {IMPORT_TABLE} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), proof TEXT NOT NULL)")
                    conn.execute(f"INSERT INTO {IMPORT_TABLE} VALUES(1,?)", (canonical(proof),))
                    require(read_receipt(conn) == proof, "import_receipt_verification_failed")
                else:
                    receipt.setdefault("added_columns", {})
                    require(receipt.get("database_id") == database.instance_id, "import_target_binding_mismatch")
                    require(all(receipt.get(key) == value for key, value in base.items()), "import_source_changed")
                    rows = {table.name: data_digest(table.source_rows(source)) for table in mappings}
                    require(rows == receipt["tables"], "import_source_changed")
                    if active:
                        retained = checkpoints(source, tables, original, None, source_only=True)
                        expected = {k: v for k, v in receipt["checkpoints"].items() if k != "target_digest"}
                        require(retained == expected, "import_source_checkpoints_changed")
                    else:
                        derived = {"discovery_provider_checkpoints", "discovery_provider_keys", "discovery_provider_cooldowns"}
                        check_stage(conn, target_tables, populated=tables | {IMPORT_TABLE} |
                                    (derived if "discovery_units" in tables else set()))
                        for name, identities in receipt["next_identities"].items():
                            for column, next_id in identities.items():
                                verify_sequence(conn, name, column, next_id)
                        for table in mappings:
                            require(verify_table(conn, table) == rows[table.name], f"staged_content_changed:{table.name}")
                        checkpoint_proof = checkpoints(source, tables, original, conn, verify_only=True)
                        require(receipt["checkpoints"] == checkpoint_proof, "staged_checkpoints_changed")
                    proof = receipt
                if seal is not None:
                    if active:
                        require(seal.record is not None, "active_target_without_source_seal")
                        seal.exclusive()
                    else:
                        seal.apply(database.instance_id)
                if not active and not rehearse:
                    if seal is None:
                        held.verify()
                    database.activate_import(conn)
                return {"state": "active" if active or not rehearse else "verified_stage",
                        "tables": len(proof["tables"]), "rows": sum(row["rows"] for row in proof["tables"].values()),
                        "sequences": sum(len(seq) for seq in proof["next_identities"].values()),
                        "files": files, "external_state": outstanding, "checkpoints": proof["checkpoints"],
                        "receipt_sha256": fingerprint(proof)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", required=True, type=Path, help="Private Python SQLite database or online backup")
    parser.add_argument("--workspace", required=True, type=Path, help="Workspace bound to the PostgreSQL destination")
    parser.add_argument("--artifact-workspace", type=Path, help="Original workspace containing the existing file authorities")
    parser.add_argument("--rehearse", action="store_true", help="Verify a staged copy without permitting startup")
    parser.add_argument("--seal-source", action="store_true", help="Native macOS activation: retain a read-only canonical predecessor")
    args = parser.parse_args(argv)
    try:
        result = import_workspace(args.sqlite, args.workspace, artifact_workspace=args.artifact_workspace,
                                  rehearse=args.rehearse, seal_source=args.seal_source)
    except (UpgradeError, AppError) as error:
        print(canonical({"error": error.code if isinstance(error, AppError) else str(error)}), file=sys.stderr)
        return 1
    except (sqlite3.Error, ValueError, OSError, KeyError, TypeError):
        print(canonical({"error": "invalid_source_or_file_authority"}), file=sys.stderr)
        return 1
    except Exception:
        print(canonical({"error": "postgres_upgrade_failed"}), file=sys.stderr)
        return 1
    print(canonical(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
