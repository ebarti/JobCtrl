"""Exercise the real worker/material writer in the owned browser QA workspace."""

import json
from pathlib import Path
import sys

from jobctrl import config, database
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.scoring import tailor
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.domain.tenant import LOCAL_TENANT
from tests.availability_fixture import seed_fresh_availability


root = config.APP_DIR.resolve()
assert (root / ".jobctrl-e2e-owned.json").is_file(), "An owned synthetic E2E workspace is required"
assert config.DB_PATH.resolve().is_relative_to(root)
assert config.get_resume_tailoring_enabled() is False

job_id = canonical_job_id(sys.argv[1])
conn = database.get_connection()
score_before = tuple(conn.execute("SELECT * FROM job_scores WHERE job_id=? ORDER BY version", (str(job_id),)).fetchall())
seed_fresh_availability(conn, str(job_id), "local")
conn.commit()


def forbid_model(**_kwargs):
    raise AssertionError("Baseline preparation acquired model services")


tailor._build_use_case = forbid_model
tailor.get_llm_adapter = forbid_model
tailor._build_voice_port = forbid_model
outcome = tailor.tailor_job_by_id(job_id, retailor=True)
target = SqlitePreparationTargetReader(conn).load(LOCAL_TENANT, job_id)
assert outcome["status"] == "approved", {
    "reason": outcome.get("error") or outcome.get("reason"),
    "has_description": bool(target and target.get("full_description")),
    "score": target.get("fit_score") if target else None,
    "enrichment_status": target.get("enrichment_status") if target else None,
    "stages": [dict(row) for row in conn.execute("SELECT stage,state,attempt_count FROM job_stage_states WHERE job_id=?", (str(job_id),))],
}
score_after = tuple(conn.execute("SELECT * FROM job_scores WHERE job_id=? ORDER BY version", (str(job_id),)).fetchall())
assert score_after == score_before
materials = outcome["materials"]
assert Path(outcome["pdf_path"]).is_file()
print(json.dumps({
    "jobId": str(job_id), "generation": materials.generation, "scoreUnchanged": True,
    "textArtifactId": materials.tailored_resume.artifact_id,
    "pdfArtifactId": materials.resume_pdf.artifact_id,
    "textPath": outcome["path"], "pdfPath": outcome["pdf_path"],
    "origin": materials.tailored_resume.metadata["base_profile_copy"],
}))
database.close_thread_connections()
