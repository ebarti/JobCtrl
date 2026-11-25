"""Create a synthetic migration source from the pinned predecessor's schema declarations."""

import argparse
import ast
import base64
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from jobctrl.app.postgres_upgrade_contract import SOURCE_CONTRACT
from jobctrl.app.postgres_upgrade_schema import FEATURE_SCHEMAS


def declaration(root, module, symbol):
    file = root.joinpath(*module.split(".")).with_suffix(".py")
    for node in ast.parse(file.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == symbol for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f"Missing predecessor declaration {symbol}.")


def edge_cases(conn, workspace):
    stamp = "2026-01-01T00:00:00+00:00"
    conn.execute("ALTER TABLE app_events ADD COLUMN annotation BLOB")
    conn.execute("UPDATE app_events SET annotation=?", (b"\x00\xff",))
    conn.execute("INSERT INTO app_events(event_id,event_type,feature,occurred_at,payload_json) VALUES(41,'Deleted','jobs',?,'{}')", (stamp,))
    conn.execute("DELETE FROM app_events WHERE event_id=41")
    conn.execute("INSERT INTO fit_refresh_operations(rowid,operation_id,profile_id,input_fingerprint,status,state_json,created_at,updated_at) "
                 "VALUES(21,'op','default','hash','failed','{}',?,?)", (stamp, stamp))
    conn.execute("INSERT INTO requirements_retrieval(requirement_id,revision,document) VALUES('requirement',2,'café')")
    conn.execute("INSERT INTO app_model_calls(receipt_id,operation,provider,model,lane,prompt_version,input_fingerprint,"
                 "created_at,status,provider_started,owner_pid) VALUES('receipt','fit','synthetic','model','fit','v1','hash',?,'uncertain',1,1)", (stamp,))
    conn.execute("INSERT INTO applications_submit_intents VALUES('local','intent','job','run','payload','hash','approval','hash',?)", (stamp,))
    attachment = b"synthetic attachment\x00"
    content = {"attachment": {"data_base64": base64.b64encode(attachment).decode(), "sha256": hashlib.sha256(attachment).hexdigest()}}
    conn.execute("INSERT INTO profile_sources VALUES('default','source',1,?,'confirmed',1)", (json.dumps(content),))
    conn.execute("INSERT INTO profile_source_versions VALUES('default','source',1,?)", (json.dumps(content),))
    pdf_dir = workspace / "resumes-artifacts"
    pdf_dir.mkdir(mode=0o700)
    aid = str(uuid4())
    filename = aid + ".pdf"
    pdf = pdf_dir / filename
    # The importer checks persisted file custody and exact bytes. Rendering is
    # qualified separately through the normal application/renderer journeys.
    pdf.write_bytes(b"%PDF-1.4\n%synthetic file custody proof\n%%EOF\n")
    pdf.chmod(0o600)
    def identity(path):
        info = path.stat()
        return {"device": info.st_dev, "inode": info.st_ino}
    artifact = {"artifact_id": aid, "filename": filename, "path": str(pdf), "size_bytes": pdf.stat().st_size,
                "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(), "file_identity": identity(pdf),
                "root_identity": identity(pdf_dir), "resume_id": "resume", "revision_id": "revision"}
    state = {"revisions": [{"renders": [artifact]}], "acceptances": [{"pdf": artifact}], "locales": []}
    conn.execute("INSERT INTO resumes_documents VALUES('resume','job',1,?,?)", (json.dumps(state), stamp))
    conn.execute("INSERT INTO resumes_artifact_retirements(artifact_id,job_id,artifact_json,status,reason,created_at,updated_at)"
                 " VALUES(?,'job',?,'registered','registered_render',?,?)", (aid, json.dumps(artifact), stamp, stamp))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path, help="Extracted f8e329d2 predecessor repository root")
    parser.add_argument("--workspace", required=True, type=Path, help="New synthetic workspace under the system temporary root")
    parser.add_argument("--migration-edges", action="store_true", help="Add file, uncertainty, sequence and binary preservation cases")
    args = parser.parse_args()
    root = args.checkout / "workers/automation/src/jobctrl"
    workspace = args.workspace.resolve()
    if not workspace.is_relative_to(Path(tempfile.gettempdir()).resolve()) and not workspace.is_relative_to(Path("/private/tmp")):
        raise ValueError("Use a new synthetic workspace under the system temporary root.")
    workspace.mkdir(mode=0o700, exist_ok=False)
    file = workspace / "jobctrl.db"
    os.close(os.open(file, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600))
    with closing(sqlite3.connect(file)) as conn:
        for name, module, symbol in (("core", "app.database", "CORE_SCHEMA"), *FEATURE_SCHEMAS):
            ddl = declaration(root, module, symbol)
            digest = hashlib.sha256(ddl.encode()).hexdigest()
            if digest != SOURCE_CONTRACT[name][0]:
                raise ValueError(f"Incompatible predecessor {name} schema.")
            conn.executescript(ddl)
            if name != "core":
                conn.execute("INSERT INTO app_feature_schemas VALUES(?,?)", (name, digest))
        conn.executescript("PRAGMA application_id=1245926228; PRAGMA user_version=1;")
        settings = declaration(root, "app.settings", "DEFAULTS")
        conn.execute("INSERT INTO app_settings VALUES(1,3,?)", (json.dumps(settings),))
        conn.execute("INSERT INTO app_events(event_type,feature,occurred_at,payload_json) "
                     "VALUES('SyntheticUpgrade','app','2026-01-01T00:00:00+00:00','{}')")
        if args.migration_edges:
            edge_cases(conn, workspace)
        conn.commit()


if __name__ == "__main__":
    main()
