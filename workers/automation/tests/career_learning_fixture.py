"""Owned synthetic sources and an explicit model double, never recorded output."""

import json
import sqlite3
from types import SimpleNamespace

from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.llm_lanes import current_llm_lane

JOB = "90000000-0000-4000-8000-000000000038"
DUPLICATE = "90000000-0000-4000-8000-000000000039"
MISSING = "90000000-0000-4000-8000-000000000040"
POSTING = "Synthetic role requires service operations and incident practice."
EVIDENCE = "Owned synthetic incident exercise."


def seed(path=":memory:"):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    create_exact_v14_schema(conn)
    for job_id in (JOB, DUPLICATE, MISSING):
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title,company,description) VALUES('local',?,?, 'Synthetic engineer','Synthetic employer',?)",
            (job_id, "https://jobs.example/" + job_id, POSTING if job_id != MISSING else ""),
        )
    for job_id in (JOB, DUPLICATE):
        conn.execute(
            "INSERT INTO job_application_locators VALUES('local',?,?)", (job_id, "https://apply.example/one-identity")
        )
    conn.commit()
    repository = SqliteProfileRepository(conn, publisher=SimpleNamespace(publish=lambda _event: None))
    repository.save(
        TenantId("local"),
        Profile.from_dict(
            TenantId("local"),
            {
                "resume": {
                    "experience_entries": [
                        {
                            "id": "synthetic-role",
                            "title": "Engineer",
                            "company": "Synthetic employer",
                            "achievement_evidence": [
                                {
                                    "id": "confirmed-incident",
                                    "source_text": EVIDENCE,
                                    "evidence_strength": "verified",
                                    "user_confirmed": True,
                                },
                                {
                                    "id": "unconfirmed",
                                    "source_text": "Private unconfirmed statement",
                                    "evidence_strength": "draft",
                                    "user_confirmed": False,
                                },
                            ],
                        }
                    ],
                    "skill_categories": [
                        {"id": "declared", "label": "Declarations", "items": ["Unproven declaration"]}
                    ],
                },
            },
        ),
    )
    conn.commit()
    return conn


class Model:
    def __init__(self, *, capability="partial", fault=None, callback=None):
        self.capability, self.fault, self.callback, self.calls = capability, fault, callback, []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "profile"
        data = json.loads(messages[1].content)
        self.calls.append(data)
        if self.callback:
            self.callback()
        if isinstance(self.fault, Exception):
            raise self.fault
        posting = next(source for source in data["sources"] if source["source_id"].startswith("posting:"))
        fact = next((source for source in data["sources"] if source["source_id"] == "confirmed-incident"), None)
        result = {
            "demands": [
                {
                    "demand_id": "operations",
                    "skill": "Service operations",
                    "mentions": [{"source_id": posting["source_id"], "quote": posting["text"], "exact_values": []}],
                    "capability": self.capability,
                    "evidence": [{"source_id": fact["source_id"], "quote": EVIDENCE, "exact_values": []}]
                    if fact and self.capability in {"partial", "demonstrated"}
                    else [],
                    "rationale": "Explicit synthetic model judgment.",
                    "uncertainty": "One owned exercise is limited evidence.",
                }
            ],
            "proposals": [
                {
                    "proposal_id": "practice",
                    "demand_id": "operations",
                    "kind": "evidence_building",
                    "title": "Document an incident exercise",
                    "action": "Run an owned practice incident and retain a report.",
                    "completion_criterion": "A reviewed report identifies decisions and observed results.",
                    "rationale": "Build inspectable experience.",
                }
            ],
            "uncertainty": "Small selected cohort; incomplete descriptions and unresolved duplicates may limit observations.",
        }
        if callable(self.fault):
            self.fault(result)
        return result


def dependencies(conn, model, preflight=lambda: None):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="profile",
        preflight=preflight,
    )


def compare_command(**changes):
    return {
        "action": "compare",
        "expectedRevision": 0,
        "title": "Owned synthetic cohort",
        "asOf": "2026-10-18",
        "aspirations": "Explore a future leadership role",
        "jobIds": [JOB, JOB, DUPLICATE, MISSING],
        **changes,
    }


if __name__ == "__main__":
    import sys
    from pathlib import Path
    from jobctrl.infrastructure.career_learning import CareerLearningService

    if sys.argv[1] == "--rpc":
        import os
        from jobctrl.infrastructure import career_learning
        from jobctrl.infrastructure.rpc.handlers import register_default_handlers
        from jobctrl.infrastructure.rpc.server import JsonRpcServer

        directory = Path(os.environ["JOBCTRL_DIR"])
        if not (directory / ".career-learning-test").is_file():
            raise RuntimeError("Owned synthetic test workspace required")

        def injected(connection, *, tenant_id, lane):
            assert lane == "profile" and tenant_id == "local"
            failure = (
                RuntimeError("Synthetic provider failure")
                if (directory / ".career-learning-provider-failure").exists()
                else None
            )
            return dependencies(connection, Model(fault=failure))

        career_learning.determination_dependencies = injected
        server = JsonRpcServer()
        register_default_handlers(server, canceler=lambda _identity: None)
        server.serve()
        raise SystemExit()

    conn = seed(sys.argv[1])
    service = CareerLearningService(conn, dependencies=dependencies(conn, Model()))
    state = service.execute(compare_command())
    conn.close()
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(state))
    else:
        print(json.dumps(state))
