"""Import predecessor SDK positions using private copies of its directory and WAL files."""

from contextlib import closing
from datetime import datetime
import hashlib
import json
from math import isfinite
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

from jobctrl.features.discovery.adapters.checkpoints import insert_checkpoint, read_checkpoint
from jobctrl.features.discovery.domain import fingerprint


def _digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _snapshot_file(source, target):
    if source.is_symlink() or not source.is_file() or source.stat().st_uid != os.getuid() or source.stat().st_nlink != 1:
        raise ValueError("A provider checkpoint is not a regular workspace file.")
    before = _digest(source)
    shutil.copyfile(source, target)
    if before != _digest(target) or before != _digest(source):
        raise ValueError("A provider checkpoint changed during migration. Stop writers and retry.")
    return before


def _load_snapshot(source, temporary):
    from jobstreaming import default_registry
    from jobstreaming.checkpoint import SqliteCheckpointStore
    from jobstreaming.events import CHECKPOINT_VERSION

    target = temporary / "provider.sqlite3"
    suffixes = ("", "-wal", "-journal")
    if any(Path(str(source) + suffix).is_symlink() for suffix in (*suffixes, "-shm")):
        raise ValueError("A provider checkpoint or sidecar is a symbolic link.")
    digests = {}
    for suffix in suffixes:
        path = Path(str(source) + suffix)
        if suffix == "" or path.exists():
            digests[suffix] = _snapshot_file(path, Path(str(target) + suffix))
    for suffix in suffixes:
        path = Path(str(source) + suffix)
        if path.exists() != (suffix in digests) or path.exists() and _digest(path) != digests[suffix]:
            raise ValueError("A provider checkpoint changed during migration. Stop writers and retry.")
    with closing(sqlite3.connect(target)) as conn:
        if conn.execute("PRAGMA quick_check").fetchone() != ("ok",) or conn.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Provider checkpoint integrity validation failed.")
        if conn.execute("SELECT version FROM jobstreaming_checkpoint_schema WHERE singleton=1").fetchone() != (1,):
            raise ValueError("Unsupported provider checkpoint schema.")
    checkpoint = SqliteCheckpointStore(target).load()
    if checkpoint is not None:
        if checkpoint.version != CHECKPOINT_VERSION:
            raise ValueError("Unsupported provider cursor version.")
        registry = default_registry()
        for site, state in checkpoint.adapters.items():
            if (site != state.site.value or registry.cursor_schema_version(site) != state.cursor_schema_version
                    or state.emitted_count != len(state.seen_job_keys) or len(set(state.seen_job_keys)) != len(state.seen_job_keys)):
                raise ValueError("Unsupported or inconsistent provider cursor.")
    return checkpoint


def _legacy_cooldowns(sqlite_conn):
    deadlines = {}
    for payload, in sqlite_conn.execute(
            "SELECT payload_json FROM app_events WHERE event_type='DiscoverySourceRateLimited' ORDER BY event_id"):
        observation = json.loads(payload)
        delay = observation.get("retryAfterSeconds")
        if delay is None:
            # The predecessor required explicit continuation when no server time was given.
            continue
        if type(delay) not in {int,float} or not isfinite(delay) or delay < 0:
            raise ValueError("Invalid historical provider cooldown.")
        observed = datetime.fromisoformat(observation["receivedAt"])
        if observed.tzinfo is None or not isinstance(observation["board"],str):
            raise ValueError("Incomplete historical provider cooldown.")
        deadline = observed.timestamp() + delay
        if not isfinite(deadline):
            raise ValueError("Invalid historical provider cooldown.")
        board = observation["board"]
        deadlines[board] = max(deadlines.get(board, 0.0), deadline)
    return deadlines


def import_legacy_checkpoints(sqlite_conn, original_workspace_path, pg_connection=None, *, verify_only=False, source_only=False):
    if verify_only and source_only or not source_only and pg_connection is None:
        raise ValueError("Choose one provider checkpoint verification mode.")
    root = Path(original_workspace_path) / "discovery-checkpoints"
    runs = {fingerprint(row[0]): row[0] for row in sqlite_conn.execute("SELECT run_id FROM discovery_runs")}
    units = {(row[0], row[1]): row[2] for row in sqlite_conn.execute("SELECT run_id,unit_id,status FROM discovery_units")}
    source = hashlib.sha256()
    target = hashlib.sha256()
    found = set()
    files = accepted = keys = 0
    if root.is_symlink() or root.exists() and (not root.is_dir() or root.stat().st_uid != os.getuid()):
        raise ValueError("The provider checkpoint directory is unowned.")
    for directory in sorted(root.iterdir()) if root.exists() else ():
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != os.getuid() or directory.name not in runs:
            raise ValueError("Unowned provider checkpoint directory.")
        for path in sorted(directory.iterdir()):
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_nlink != 1:
                raise ValueError("Unowned provider checkpoint file.")
            if path.name.endswith((".sqlite3-shm", ".sqlite3-wal", ".sqlite3-journal")) and path.with_name(path.name.rsplit("-", 1)[0]).is_file():
                continue
            run_id, unit_id = runs[directory.name], path.stem
            if path.suffix != ".sqlite3" or (run_id, unit_id) not in units:
                raise ValueError("A provider checkpoint has no corresponding Discovery unit.")
            files += 1
            with tempfile.TemporaryDirectory(prefix="jobctrl-cursor-") as private:
                old = _load_snapshot(path, Path(private))
            if old is None:
                continue
            found.add((run_id, unit_id))
            accepted += 1
            keys += sum(len(adapter.seen_job_keys) for adapter in old.adapters.values())
            source.update(fingerprint([run_id, unit_id, old.model_dump(mode="json")]).encode())
            if source_only:
                continue
            if not verify_only:
                insert_checkpoint(pg_connection, run_id, unit_id, old)
            copied = read_checkpoint(pg_connection, run_id, unit_id)
            if copied is None:
                raise ValueError("A previously copied provider checkpoint is missing.")
            target.update(fingerprint([run_id, unit_id, copied.model_dump(mode="json")]).encode())
    # An unfinished unit with acknowledged intake must retain its saved position.
    expected = {(r[0], r[1]) for r in sqlite_conn.execute(
        "SELECT DISTINCT r.run_id,r.unit_id FROM discovery_intake_receipts r JOIN discovery_units u "
        "ON (u.run_id=r.run_id AND u.unit_id=r.unit_id) WHERE u.status IN ('running','deferred','waiting_for_query_turn','failed') "
        "AND json_extract(u.data_json,'$.source_family')='broad_boards'"
    )}
    if expected - found:
        raise ValueError("An unfinished board lost its acknowledged provider checkpoint.")
    deadlines = _legacy_cooldowns(sqlite_conn)
    cooldown_rows = [(board, retry_at, 0.0, 1, 1) for board, retry_at in sorted(deadlines.items())]
    source.update(fingerprint(cooldown_rows).encode())
    report = {"files": files, "checkpoints": accepted, "seen_keys": keys, "cooldowns": len(deadlines),
              "source_digest": source.hexdigest()}
    if source_only:
        return report
    if not verify_only:
        for row in cooldown_rows:
            pg_connection.execute("INSERT INTO discovery_provider_cooldowns VALUES(?,?,?,?,?)", row)
    stored = [tuple(row) for row in pg_connection.execute(
        "SELECT board,retry_at,next_request_at,consecutive_limits,retry_advertised FROM discovery_provider_cooldowns ORDER BY board")]
    target.update(fingerprint(stored).encode())
    target_keys = {tuple(row) for row in pg_connection.execute("SELECT run_id,unit_id FROM discovery_provider_checkpoints")}
    if target_keys != found or source.digest() != target.digest():
        raise ValueError("Provider checkpoint positions and deadlines could not be reconciled.")
    return {**report, "target_digest": target.hexdigest()}
