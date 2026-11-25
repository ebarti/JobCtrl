"""Reproduce migration writer fencing, interrupted native sealing, and repeatable admission in a disposable cluster."""

import argparse
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

import psycopg

SCRIPTS = Path(__file__).resolve().parent
SOURCE = SCRIPTS.parent / "src"
sys.path.insert(0, str(SOURCE))


def eventually(predicate, deadline=60):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError("Timed out waiting for the observed migration boundary.")


@contextmanager
def cluster(directory, binaries):
    data, sockets = directory / "cluster", directory / "socket"
    sockets.mkdir(mode=0o700)
    subprocess.run([binaries / "initdb", "-D", data, "-U", "qa", "-A", "trust", "--no-locale", "--encoding=UTF8"],
                   check=True, stdout=subprocess.DEVNULL)
    # A fresh private socket directory isolates the test, even if port 5432 is
    # in use. No TCP listener or caller-selected existing database is involved.
    with (directory / "postgres.log").open("wb") as log, subprocess.Popen(
        [binaries / "postgres", "-D", data, "-k", sockets, "-p", "5432", "-c", "listen_addresses="],
        stdout=log, stderr=log,
    ) as server:
        try:
            def listening():
                if server.poll() is not None:
                    raise RuntimeError("Owned PostgreSQL server exited during startup.")
                try:
                    with socket.socket(socket.AF_UNIX) as probe:
                        probe.connect(str(sockets / ".s.PGSQL.5432"))
                    return True
                except OSError:
                    return False
            eventually(listening)
            base = f"postgresql://qa@/{{}}?host={sockets}&port=5432"
            def bootstrap():
                try:
                    with psycopg.connect(base.format("postgres"), autocommit=True) as conn:
                        conn.execute("CREATE DATABASE rehearsal")
                        conn.execute("CREATE DATABASE cutover")
                    return True
                except psycopg.OperationalError:
                    return False
            eventually(bootstrap)
            yield base.format("rehearsal"), base.format("cutover")
        finally:
            server.terminate()
            server.wait(timeout=30)


def cli(source, workspace, url, *args):
    command = [sys.executable, "-m", "jobctrl.app.postgres_upgrade", "--sqlite", str(source),
               "--workspace", str(workspace), *args]
    env = {**os.environ, "PYTHONPATH": str(SOURCE), "JOBCTRL_DATABASE_URL": url}
    return subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def outcome(process, expected):
    try:
        out, err = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise
    result = json.loads(err if process.returncode else out)
    assert result.get("error", result.get("state")) == expected, (expected, result)
    return result


def rehearse(source, stage, url):
    original_entries = set(source.parent.iterdir())
    original_digest = hashlib.sha256(source.read_bytes()).digest()
    outcome(cli(source, source.parent, url, "--rehearse"), "rehearsal_requires_separate_workspace")
    result = outcome(cli(source, stage, url, "--rehearse"), "verified_stage")
    assert outcome(cli(source, stage, url, "--rehearse"), "verified_stage") == result
    assert result["files"] == {"profile_attachments": 2, "registered_pdfs": 1}
    assert result["external_state"]["uncertain_model_calls"] == result["external_state"]["unacknowledged_submit_intents"] == 1
    assert set(source.parent.iterdir()) == original_entries
    assert hashlib.sha256(source.read_bytes()).digest() == original_digest
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("UPDATE app_events SET event_type='Altered'")
        outcome(cli(source, stage, url, "--rehearse"), "staged_content_changed:app_events")
        conn.execute("UPDATE app_events SET event_type='SyntheticUpgrade'")
        conn.execute("ALTER TABLE app_events ALTER COLUMN event_id RESTART WITH 1")
        outcome(cli(source, stage, url, "--rehearse"), "sequence_verification_failed:app_events")


def native_cutover(source, url):
    from jobctrl.app.database import Database
    root = source.parent
    # A pre-existing descriptor survives chmod. Actual macOS enumeration must
    # see it while the importer holds its own writer reservation.
    with source.open("rb"):
        outcome(cli(source, root, url, "--seal-source"), "sqlite_source_descriptor_busy_or_unknown")
    assert stat.S_IMODE(source.stat().st_mode) == 0o600
    journal = json.loads((root / ".jobctrl-sqlite-seal.json").read_text())
    assert journal["source_inode"] == source.stat().st_ino and journal["original_mode"] == 0o600
    with psycopg.connect(url) as lock, psycopg.connect(url, autocommit=True) as monitor:
        lock.execute("LOCK TABLE app_metadata IN SHARE MODE")
        child = cli(source, root, url, "--seal-source")
        try:
            def waiting_to_activate():
                if child.poll() is not None:
                    raise AssertionError(child.communicate())
                return monitor.execute("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() "
                                       "AND wait_event_type='Lock' AND query LIKE 'UPDATE app_metadata SET value=%')").fetchone()[0]
            eventually(waiting_to_activate)
            assert stat.S_IMODE(source.stat().st_mode) == 0o400
            child.kill()
            child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            lock.rollback()
    with closing(Database(root, database_url=url, staging=True)) as staged, staged.connect() as conn:
        assert conn.execute("SELECT to_regclass('app_sqlite_import_receipt')").fetchone()[0] is None
        assert conn.execute("SELECT count(*) FROM app_events").fetchone()[0] == 0


def run(checkout, binaries):
    with tempfile.TemporaryDirectory(prefix="jc-migrate-", dir="/tmp") as temporary:
        directory = Path(temporary).resolve()
        root = directory / "original"
        subprocess.run([sys.executable, SCRIPTS / "qa_postgres_upgrade_source.py", "--checkout", checkout,
                        "--workspace", root, "--migration-edges"], check=True)
        source = root / "jobctrl.db"
        with cluster(directory, binaries) as (rehearsal, live):
            rehearse(source, directory / "stage", rehearsal)
            digest = hashlib.sha256(source.read_bytes()).digest()
            with closing(sqlite3.connect(source)) as old_writer:
                old_writer.execute("BEGIN IMMEDIATE")
                outcome(cli(source, root, live), "predecessor_writer_busy")
                old_writer.rollback()
            flags = []
            if sys.platform == "darwin":
                flags = ["--seal-source"]
                native_cutover(source, live)
            first = outcome(cli(source, root, live, *flags), "active")
            with psycopg.connect(live, autocommit=True) as conn:
                assert conn.execute("INSERT INTO app_events(event_type,feature,occurred_at,payload_json) "
                                    "VALUES('AfterCutover','app','now','{}') RETURNING event_id").fetchone()[0] == 42
                assert bytes(conn.execute("SELECT annotation FROM app_events WHERE event_id=1").fetchone()[0]) == b"\x00\xff"
                assert conn.execute("SELECT insertion_order FROM fit_refresh_operations").fetchone()[0] == 21
            assert outcome(cli(source, root, live, *flags), "active") == first
            with psycopg.connect(live) as conn:
                assert conn.execute("SELECT count(*) FROM app_events").fetchone()[0] == 2
            assert hashlib.sha256(source.read_bytes()).digest() == digest
            print(json.dumps({"tables": first["tables"], "rows": first["rows"], "sequences": first["sequences"],
                              "native_seal": bool(flags), "verified": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True, help="Extracted predecessor repository root (f8e329d2)")
    parser.add_argument("--postgres-bin", type=Path, required=True, help="Directory containing initdb and postgres")
    options = parser.parse_args()
    run(options.checkout.resolve(), options.postgres_bin.resolve())
