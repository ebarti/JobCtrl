"""SQLite adapter for Applications. No SQL crosses a feature boundary."""

from __future__ import annotations

import json
from contextlib import closing, contextmanager

from .domain import ApplicationFailure, copied, digest, timestamp


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class ApplicationRepository:
    def __init__(self, runtime):
        self.runtime = runtime

    @contextmanager
    def read(self, connection=None):
        if connection is not None:
            yield connection
        else:
            with closing(self.runtime.database.connect()) as conn:
                yield conn

    @contextmanager
    def atomic(self, connection=None):
        if connection is not None:
            if not connection.in_transaction:
                raise ApplicationFailure("applications_caller_transaction_required")
            yield connection
        else:
            with self.runtime.database.transaction() as conn:
                yield conn

    def event(self, conn, event_type, job_id, **references):
        return self.runtime.events.append(conn, event_type, {"jobId": job_id, **references},
                                          feature="applications", aggregate_id=job_id)

    def state(self, conn, tenant, job):
        row = conn.execute("SELECT state_json FROM applications_state WHERE tenant_id=? AND job_id=?", (tenant, job)).fetchone()
        if row:
            return json.loads(row[0])
        return {"jobId": job, "version": 0, "status": "unprepared", "payloadId": None,
                "latestDecision": None, "runId": None, "stopped": False, "attemptCount": 0, "claimEpoch": 0, "updatedAt": None}

    def states(self, conn, tenant):
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT state_json FROM applications_state WHERE tenant_id=? ORDER BY updated_at DESC,job_id", (tenant,))]

    def save_state(self, conn, tenant, state, expected):
        next_state = copied(state)
        next_state.update(version=expected + 1, updatedAt=timestamp())
        if expected == 0:
            cursor = conn.execute(
                "INSERT INTO applications_state(tenant_id,job_id,version,state_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
                (tenant, state["jobId"], 1, encode(next_state), next_state["updatedAt"]))
        else:
            cursor = conn.execute(
                "UPDATE applications_state SET version=?,state_json=?,updated_at=? WHERE tenant_id=? AND job_id=? AND version=?",
                (expected + 1, encode(next_state), next_state["updatedAt"], tenant, state["jobId"], expected))
        if cursor.rowcount != 1:
            raise ApplicationFailure("application_revision_conflict", conflict=True)
        return next_state

    def repeated(self, conn, tenant, key, request):
        row = conn.execute("SELECT request_sha256,response_json FROM applications_action_receipts WHERE tenant_id=? AND action_key=?",
                           (tenant, key)).fetchone()
        if row is None:
            return None
        if row[0] != digest(request):
            raise ApplicationFailure("application_idempotency_conflict", conflict=True)
        return json.loads(row[1])

    def receipt(self, conn, tenant, key, request, response):
        conn.execute("INSERT INTO applications_action_receipts VALUES(?,?,?,?,?)",
                     (tenant, key, digest(request), encode(response), timestamp()))

    def add_payload(self, conn, tenant, payload):
        conn.execute("INSERT INTO applications_payloads VALUES(?,?,?,?,?,?)", (
            tenant, payload["payloadId"], payload["jobId"], payload["payloadSha256"], encode(payload), payload["createdAt"]))

    def payload(self, conn, tenant, ident):
        row = conn.execute("SELECT payload_json,payload_sha256 FROM applications_payloads WHERE tenant_id=? AND payload_id=?", (tenant, ident)).fetchone()
        if row is None:
            raise ApplicationFailure("application_payload_not_found")
        value = json.loads(row[0])
        if value["payloadSha256"] != row[1] or digest({k: v for k, v in value.items() if k != "payloadSha256"}) != row[1]:
            raise ApplicationFailure("application_payload_corrupt")
        return value

    def decision(self, conn, tenant, decision):
        conn.execute("INSERT INTO applications_decisions(tenant_id,decision_id,job_id,payload_id,decision,decision_json) VALUES(?,?,?,?,?,?)",
                     (tenant, decision["decisionId"], decision["jobId"], decision["payloadId"], decision["decision"], encode(decision)))

    def latest_decision(self, conn, tenant, job):
        row = conn.execute("SELECT decision_json FROM applications_decisions WHERE tenant_id=? AND job_id=? ORDER BY sequence DESC LIMIT 1",
                           (tenant, job)).fetchone()
        return json.loads(row[0]) if row else None

    def decisions(self, conn, tenant, job):
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT decision_json FROM applications_decisions WHERE tenant_id=? AND job_id=? ORDER BY sequence", (tenant, job))]

    def save_run(self, conn, tenant, run, *, new=False):
        run["updatedAt"] = timestamp()
        if new:
            conn.execute("INSERT INTO applications_runs VALUES(?,?,?,?,?,?,?,?)", (
                tenant, run["runId"], run["jobId"], run["payloadId"], run["approvalId"], run["status"], encode(run), run["updatedAt"]))
        else:
            changed = conn.execute("UPDATE applications_runs SET status=?,run_json=?,updated_at=? WHERE tenant_id=? AND run_id=? AND job_id=?", (
                run["status"], encode(run), run["updatedAt"], tenant, run["runId"], run["jobId"])).rowcount
            if changed != 1:
                raise ApplicationFailure("application_run_owner_changed", conflict=True)

    def run(self, conn, tenant, ident):
        row = conn.execute("SELECT run_json FROM applications_runs WHERE tenant_id=? AND run_id=?", (tenant, ident)).fetchone()
        return json.loads(row[0]) if row else None

    def runs(self, conn, tenant, job):
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT run_json FROM applications_runs WHERE tenant_id=? AND job_id=? ORDER BY updated_at,run_id", (tenant, job))]

    def intent(self, conn, tenant, job):
        row = conn.execute("SELECT * FROM applications_submit_intents WHERE tenant_id=? AND job_id=?", (tenant, job)).fetchone()
        return dict(row) if row else None

    def submit_receipt(self, conn, tenant, intent_id):
        row = conn.execute("SELECT * FROM applications_submit_receipts WHERE tenant_id=? AND intent_id=?", (tenant, intent_id)).fetchone()
        return dict(row) if row else None

    def add_intent(self, conn, tenant, intent):
        conn.execute("INSERT INTO applications_submit_intents VALUES(?,?,?,?,?,?,?,?,?)", (
            tenant, intent["intentId"], intent["jobId"], intent["runId"], intent["payloadId"], intent["payloadSha256"],
            intent["approvalId"], intent["attachmentSha256"], intent["createdAt"]))

    def add_submit_receipt(self, conn, tenant, intent, receipt):
        existing = self.submit_receipt(conn, tenant, intent["intent_id"])
        if existing:
            if (existing["run_id"] != intent["run_id"] or existing["payload_sha256"] != intent["payload_sha256"]
                    or json.loads(existing["receipt_json"]) != receipt):
                raise ApplicationFailure("application_receipt_binding_invalid", conflict=True)
            return
        conn.execute("INSERT INTO applications_submit_receipts VALUES(?,?,?,?,?,?)", (
            tenant, intent["intent_id"], intent["run_id"], intent["payload_sha256"], encode(receipt), timestamp()))

    def add_rehearsal(self, conn, tenant, rehearsal):
        conn.execute("INSERT INTO applications_rehearsals VALUES(?,?,?,?,?,?)", (
            tenant, rehearsal["rehearsalId"], rehearsal["jobId"], rehearsal["payloadId"], rehearsal["payloadSha256"], encode(rehearsal)))

    def rehearsal(self, conn, tenant, ident):
        row = conn.execute("SELECT rehearsal_json FROM applications_rehearsals WHERE tenant_id=? AND rehearsal_id=?", (tenant, ident)).fetchone()
        return json.loads(row[0]) if row else None

    def rehearsals(self, conn, tenant, job):
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT rehearsal_json FROM applications_rehearsals WHERE tenant_id=? AND job_id=? ORDER BY rowid DESC", (tenant, job))]

    def determination(self, conn, tenant, record):
        conn.execute("INSERT INTO applications_determinations VALUES(?,?,?,?,?,?,?,?,?)", (
            tenant, record["determinationId"], record["entityId"], record["operation"], record["bindingSha256"],
            encode(record["result"]), encode(record["provenance"]), encode({"sources": record["sources"], "request": record["request"]}), record["recordedAt"]))

    def get_determination(self, conn, tenant, ident):
        row = conn.execute("SELECT * FROM applications_determinations WHERE tenant_id=? AND determination_id=?", (tenant, ident)).fetchone()
        if row is None:
            raise ApplicationFailure("application_determination_missing")
        stored = json.loads(row["sources_json"])
        if not isinstance(stored, dict) or set(stored) != {"sources", "request"}:
            raise ApplicationFailure("application_model_binding_invalid")
        record = {"determinationId": row["determination_id"], "entityId": row["entity_id"], "operation": row["operation"],
                "bindingSha256": row["binding_sha256"], "result": json.loads(row["result_json"]),
                "provenance": json.loads(row["provenance_json"]), "sources": stored["sources"],
                "recordedAt": row["recorded_at"]}
        provenance = record["provenance"]
        if not provenance.get("receipt_id") or not provenance.get("input_fingerprint"):
            raise ApplicationFailure("application_model_provenance_missing")
        authority = self.runtime.model.receipt(provenance["receipt_id"], connection=conn)
        if (authority["status"] != "succeeded" or authority["value"] != record["result"]
                or authority["operation"] != record["operation"] or stored["request"]["operation"] != record["operation"]
                or any(authority.get(key) != provenance.get(key) for key in (
                    "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at"))):
            raise ApplicationFailure("application_model_binding_invalid")
        fingerprint = self.runtime.model.fingerprint(**stored["request"], sources=record["sources"],
            selection={"provider": provenance["provider"], "model": provenance["model"]})
        if fingerprint != provenance["input_fingerprint"] or digest(stored["request"]["context"]["binding"]) != record["bindingSha256"]:
            raise ApplicationFailure("application_model_binding_invalid")
        return record

    def failure(self, tenant, job, operation, code, question=None):
        with self.atomic() as conn:
            conn.execute("INSERT INTO applications_failures(tenant_id,job_id,question_id,operation,failure_code,recorded_at) VALUES(?,?,?,?,?,?)",
                         (tenant, job, question, operation, code, timestamp()))
            self.event(conn, "ApplicationsUpdated", job, failureCode=code, questionId=question)

    def execution_policy(self, connection=None):
        settings = self.runtime.settings.snapshot(connection)
        return {"concurrency": settings["applyConcurrency"], "timeoutSeconds": settings["applyTimeoutSeconds"],
                "budgetUsd": settings["applyMaxBudgetUsd"], "minFitScore": settings["minFitScore"]}

    def active_send_count(self, conn, tenant):
        return conn.execute("SELECT COUNT(*) FROM applications_runs WHERE tenant_id=? AND status='sending'", (tenant,)).fetchone()[0]
