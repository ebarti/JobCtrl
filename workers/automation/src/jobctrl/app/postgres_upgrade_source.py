"""Read-only admission of a consistent predecessor snapshot and its file authorities."""

import base64
from contextlib import closing, contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile

from jobctrl.app.postgres_upgrade_contract import SOURCE_CONTRACT


class UpgradeError(Exception):
    """A content-safe error suitable for the native upgrade journal."""


def require(condition, error):
    if not condition:
        raise UpgradeError(error)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def regular_private(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            (os.name == "nt" or info.st_uid == os.getuid() and not info.st_mode & 0o077), "unsafe_sqlite_source")
    return info.st_dev, info.st_ino


def source_files(source):
    identity = regular_private(source)
    with source.open("rb") as stream:
        header = stream.read(100)
        require(len(header) == 100 and header[:16] == b"SQLite format 3\x00" and
                int.from_bytes(header[68:72], "big") == 0x4A435354 and int.from_bytes(header[60:64], "big") == 1,
                "unsupported_sqlite_generation")
    companions = {}
    for suffix in ("-wal", "-shm", "-journal"):
        path = Path(str(source) + suffix)
        if path.exists() or path.is_symlink():
            companions[suffix] = regular_private(path)
    require(set(companions) in (set(), {"-shm", "-wal"}), "sqlite_snapshot_companions_unsettled")
    return identity, companions


@contextmanager
def _writer_connection(source):
    # BEGIN IMMEDIATE reserves the writer slot in both rollback-journal and
    # WAL modes. Use a different read-only handle for backup to avoid waiting
    # on our own uncommitted transaction. Never write through this handle.
    identity, _ = source_files(source)
    with closing(sqlite3.connect(source.as_uri() + "?mode=rw", uri=True, isolation_level=None, timeout=5)) as lock:
        try:
            lock.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as error:
            if error.sqlite_errorcode & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise UpgradeError("predecessor_writer_busy") from None
            raise
        try:
            require(identity == regular_private(source), "sqlite_source_changed")
            yield
        finally:
            lock.rollback()


@dataclass
class WriterFence:
    source: Path
    identity: tuple[int, int]
    process: subprocess.Popen

    def verify(self):
        require(self.process.poll() is None and regular_private(self.source) == self.identity,
                "sqlite_writer_fence_lost")


@contextmanager
def exclude_source_writers(source):
    # On POSIX, closing any descriptor for the DB in the lock-holder process
    # releases classic record locks. Isolate the SQLite lock from header,
    # backup and file-custody reads, including rollback-journal databases.
    identity = regular_private(source)
    with subprocess.Popen([sys.executable, "-m", "jobctrl.app.postgres_upgrade_source", str(source)],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as holder:
        try:
            message = holder.stdout.readline()
            if message != b"locked\n":
                raise UpgradeError("predecessor_writer_busy" if message == b"busy\n" else "sqlite_writer_fence_unavailable")
            fence = WriterFence(source, identity, holder)
            fence.verify()
            yield fence
        finally:
            holder.stdin.close()
            try:
                holder.wait(timeout=10)
            except subprocess.TimeoutExpired:
                holder.kill()
                holder.wait()


def _hold_until_parent_closes():
    # A killed parent closes its pipe in the kernel, releasing the reservation.
    try:
        with _writer_connection(Path(sys.argv[1])):
            print("locked", flush=True)
            sys.stdin.buffer.read()
    except UpgradeError as error:
        if str(error) == "predecessor_writer_busy":
            print("busy", flush=True)
        return 1
    return 0


@contextmanager
def snapshot(source):
    source = Path(source).expanduser().absolute()
    identity, companions = source_files(source)
    initial = source.stat()
    with tempfile.TemporaryDirectory(prefix="jobctrl-pg-import-") as temp:
        # A read-only WAL open can still create shared-memory files. The
        # immutable read is safe only for a stable standalone file. Reject a
        # writer racing that case. Live WAL databases use SQLite's online API.
        uri = source.as_uri() + ("?mode=ro" if companions else "?mode=ro&immutable=1")
        with closing(sqlite3.connect(uri, uri=True)) as original, \
                closing(sqlite3.connect(Path(temp) / "snapshot.db")) as copy:
            original.execute("PRAGMA query_only=ON")
            original.backup(copy, pages=512)
            require(regular_private(source) == identity, "sqlite_source_changed")
            if not companions:
                final = source.stat()
                require((initial.st_size, initial.st_mtime_ns, initial.st_ctime_ns) ==
                        (final.st_size, final.st_mtime_ns, final.st_ctime_ns) and
                        not any(Path(str(source) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")),
                        "sqlite_snapshot_changed_retry")
            copy.execute("PRAGMA query_only=ON")
            require(copy.execute("PRAGMA application_id").fetchone()[0] == 0x4A435354 and
                    copy.execute("PRAGMA user_version").fetchone()[0] == 1, "unsupported_sqlite_generation")
            require(copy.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "sqlite_integrity_failure")
            require(copy.execute("PRAGMA foreign_key_check").fetchone() is None, "sqlite_foreign_key_failure")
            yield copy


_ADDED_COLUMN = re.compile(
    r',\s*(?P<name>"?[a-z_][a-z_0-9]*"?)\s+(?P<type>TEXT|INTEGER|REAL|BLOB)'
    r"(?:\s+(?P<required>NOT\s+NULL))?(?:\s+DEFAULT\s+(?P<default>NULL|'(?:[^']|'')*'|[+-]?[0-9]+(?:\.[0-9]+)?))?\s*\)$",
    re.IGNORECASE,
)


def physical_definition(source, table, sql, count, additions):
    # ALTER TABLE ... ADD COLUMN preserves the preceding CREATE text in
    # sqlite_schema. Admit only literal, trailing fields. The original DDL
    # including every index/constraint must still match the pinned predecessor.
    info = list(source.execute(f"PRAGMA table_info({quoted(table)})"))
    for _, name, declared, required, default, pk in reversed(info[count:]):
        match = _ADDED_COLUMN.search(sql)
        require(table not in {"app_metadata", "app_feature_schemas"} and
                not table.startswith("requirements_retrieval") and match is not None and
                match["name"].strip('"') == name and len(name.encode()) <= 63 and
                declared.upper() == match["type"].upper() and not pk and
                bool(required) == bool(match["required"]) and default == match["default"],
                f"unsupported_added_column:{table}")
        if default is None or default.upper() == "NULL":
            value = None
        elif default.startswith("'"):
            value = default[1:-1].replace("''", "'")
        else:
            value = float(default) if "." in default else int(default)
        require(not required or value is not None, f"required_added_column_without_default:{table}")
        additions.setdefault(table, {})[name] = {"type": declared.upper(), "required": bool(required), "default": value}
        sql = sql[:match.start()] + ")"
    return sql


def admit_schema(source):
    metadata = dict(source.execute("SELECT key,value FROM app_metadata"))
    require(metadata == {"application": "jobctrl-python", "schema_version": "1"}, "unsupported_sqlite_identity")
    manifest = dict(source.execute("SELECT name,digest FROM app_feature_schemas"))
    require(set(manifest) <= SOURCE_CONTRACT.keys() - {"core"}, "unsupported_sqlite_feature")
    ddl = list(source.execute("SELECT name,tbl_name,type,sql FROM sqlite_master WHERE sql IS NOT NULL"))
    tables = set()
    additions = {}
    for name in ("core", *manifest):
        digest, schema_digest, members = SOURCE_CONTRACT[name]
        if name != "core":
            require(digest == manifest[name], f"unsupported_sqlite_feature_schema:{name}")
        objects = sorted((item, physical_definition(source, table, sql, members[table], additions)
                          if kind == "table" else sql) for item, table, kind, sql in ddl if table in members)
        require(fingerprint(objects) == schema_digest, f"unsupported_sqlite_physical_schema:{name}")
        tables.update(members)
    require(all(table in tables or name in ("sqlite_sequence", "sqlite_stat1", "sqlite_stat4")
                for name, table, _, _ in ddl), "unexpected_sqlite_schema_object")
    # SQLite owns only these FTS5 backing tables. The logical table, with
    # every source document and revision, is imported into the native PG index.
    shadows = {"requirements_retrieval_" + suffix for suffix in ("config", "content", "data", "docsize", "idx")}
    return tables - shadows, metadata, manifest, additions


def check_ownership(source, tables, workspace):
    if "app_worker_registrations" in tables:
        for (encoded,) in source.execute("SELECT identity_json FROM app_worker_registrations"):
            identity = json.loads(encoded)
            require(identity.get("workspace") == str(workspace), "sqlite_worker_workspace_mismatch")


def external_state(source, tables):
    def count(sql):
        return source.execute(sql).fetchone()[0]

    values = {
        "active_actions": count("SELECT count(*) FROM app_action_runs WHERE status NOT IN ('succeeded','failed','cancelled')"),
        "running_model_calls": count("SELECT count(*) FROM app_model_calls WHERE status='running'"),
        "uncertain_model_calls": count("SELECT count(*) FROM app_model_calls WHERE status='uncertain'"),
    }
    if "applications_submit_intents" in tables:
        values["unacknowledged_submit_intents"] = count(
            "SELECT count(*) FROM applications_submit_intents i WHERE NOT EXISTS ("
            "SELECT 1 FROM applications_submit_receipts r WHERE r.tenant_id=i.tenant_id AND r.intent_id=i.intent_id)")
    if "resumes_artifact_retirements" in tables:
        values["unfinished_artifact_retirements"] = count(
            "SELECT count(*) FROM resumes_artifact_retirements WHERE status IN ('rendering','retiring','pending')")
    if "extension_browser_tasks" in tables:
        values["active_extension_tasks"] = count(
            "SELECT count(*) FROM extension_browser_tasks WHERE state NOT IN ('succeeded','failed')")
        values["active_extension_captures"] = count(
            "SELECT count(*) FROM extension_capture_receipts WHERE state='importing'")
    return values


def validate_attachments(source, tables):
    count = 0
    for table, column in (("profile_sources", "content_json"), ("profile_source_versions", "record_json")):
        if table not in tables:
            continue
        for (encoded,) in source.execute(f"SELECT {column} FROM {table}"):
            attachment = json.loads(encoded).get("attachment")
            if attachment is None:
                continue
            contents = base64.b64decode(attachment["data_base64"], validate=True)
            require(hashlib.sha256(contents).hexdigest() == attachment["sha256"], "profile_attachment_digest_mismatch")
            count += 1
    return count


def validate_artifacts(source, tables, workspace):
    from jobctrl.features.resumes.repository import artifact_authority

    if "resumes_documents" not in tables:
        return 0
    root = workspace / "resumes-artifacts"
    checked = {}
    for artifact_id, encoded in source.execute(
            "SELECT artifact_id,artifact_json FROM resumes_artifact_retirements WHERE status='registered'"):
        artifact = json.loads(encoded)
        filename = artifact_id + ".pdf"
        require(artifact.get("artifact_id") == artifact_id and Path(filename).name == filename
                and artifact.get("filename") == filename and artifact.get("path") == str(root / filename),
                "resume_artifact_workspace_mismatch")
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            root_info = os.fstat(root_fd)
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_size == artifact["size_bytes"] and
                        artifact.get("file_identity", {"device": info.st_dev, "inode": info.st_ino}) ==
                        {"device": info.st_dev, "inode": info.st_ino} and
                        artifact.get("root_identity", {"device": root_info.st_dev, "inode": root_info.st_ino}) ==
                        {"device": root_info.st_dev, "inode": root_info.st_ino}, "resume_artifact_identity_mismatch")
                require(hashlib.file_digest(stream, "sha256").hexdigest() == artifact["sha256"],
                        "resume_artifact_digest_mismatch")
        finally:
            os.close(root_fd)
        checked[artifact_id] = artifact
    for (encoded,) in source.execute("SELECT state_json FROM resumes_documents"):
        state = json.loads(encoded)
        renders = [row["pdf"] for row in state["acceptances"]]
        for group in (*state["revisions"], *state["locales"]):
            renders.extend(group["renders"])
        for artifact in renders:
            require(artifact_authority(artifact) == checked.get(artifact["artifact_id"]), "resume_artifact_binding_missing")
    return len(checked)


if __name__ == "__main__":
    sys.exit(_hold_until_parent_closes())
