"""Feature-owned search controls and fenced durable execution."""

from __future__ import annotations

from contextlib import nullcontext
import json
import os
import time
from uuid import uuid4

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.features.discovery.domain import BOARD_RATE_LIMIT_CODE, DEFAULT_SETTINGS, fingerprint, now, public_board_failure, validate_settings
from jobctrl.features.discovery.qualification import posting_role_evidence, role_binding


class DiscoveryRepository:
    def __init__(self, database, events, settings, *, boards):
        self.database, self.events, self.settings = database, events, settings
        self.boards = boards

    def read_settings(self, connection=None):
        if connection is None:
            with self.database.connect() as conn:
                return self.read_settings(conn)
        row = connection.execute("SELECT revision,data_json FROM discovery_settings WHERE singleton=1").fetchone()
        settings = {**DEFAULT_SETTINGS, **(json.loads(row[1]) if row else {})}
        settings["maxParallelFamilies"] = 1
        policy = self.settings.snapshot(connection) if self.settings is not None else None
        if policy is not None:
            settings.update(
                minFitScore=policy["minFitScore"],
                autoApply=policy["applyAutomationEnabled"],
                applyApprovalRequired=True,
            )
        return {
            "ok": True,
            "revision": row[0] if row else 0,
            "settings": settings,
            "policyRevision": policy["revision"] if policy is not None else None,
            "effectiveSettings": {
                k: {
                    "value": v,
                    "source": "persisted"
                    if row or policy is not None and k in {"minFitScore", "autoApply", "applyApprovalRequired"}
                    else "default",
                    "editable": k not in {"applyApprovalRequired", "resultsPerSite", "maxParallelFamilies"},
                    "locked": k in {"applyApprovalRequired", "resultsPerSite", "maxParallelFamilies"},
                    "activation": "inactive" if k in {"resultsPerSite", "maxParallelFamilies"} else "restart"
                    if k in {"scheduleCron", "schedulingEnabled"}
                    else "next_source_family"
                    if k.startswith("crawl") or k == "useBrowserHeaders"
                    else "next_run",
                }
                for k, v in settings.items()
            },
            "effective": {
                k: {
                    "value": v,
                    "source": "persisted"
                    if row or policy is not None and k in {"minFitScore", "autoApply", "applyApprovalRequired"}
                    else "default",
                    "editable": k not in {"applyApprovalRequired", "resultsPerSite", "maxParallelFamilies"},
                    "locked": k in {"applyApprovalRequired", "resultsPerSite", "maxParallelFamilies"},
                    "activation": "inactive" if k in {"resultsPerSite", "maxParallelFamilies"} else "restart"
                    if k in {"scheduleCron", "schedulingEnabled"}
                    else "next_source_family"
                    if k.startswith("crawl") or k == "useBrowserHeaders"
                    else "next_run",
                }
                for k, v in settings.items()
            },
        }

    def save_settings(self, changes, *, connection=None):
        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            previous = self.read_settings(conn)
            expected = changes.get("expectedRevision", changes.get("revision"))
            if previous["revision"] > 0 and expected is None:
                raise AppError("expected_revision_required", "Supply the saved Discovery settings revision.", 428)
            if expected is not None and expected != previous["revision"]:
                raise ConflictError()
            if changes.get("applyApprovalRequired") is False:
                raise AppError(
                    "exact_application_approval_required", "Exact application approval cannot be disabled.", 409
                )
            if self.settings is not None:
                policy = self.settings.snapshot(conn)
                patch = {
                    target: changes[source]
                    for source, target in (("minFitScore", "minFitScore"), ("autoApply", "applyAutomationEnabled"))
                    if source in changes and changes[source] != policy[target]
                }
                if patch:
                    expected_policy = changes.get("expectedPolicyRevision")
                    if expected_policy is None:
                        raise AppError(
                            "expected_policy_revision_required", "Supply the saved application policy revision.", 428
                        )
                    self.settings.update(patch, expected_revision=expected_policy, connection=conn)
            try:
                settings = validate_settings(
                    {
                        **previous["settings"],
                        **{
                            k: v
                            for k, v in changes.items()
                            if k in DEFAULT_SETTINGS or k in {"countryIndeed", "confirmedTargets"}
                        },
                    }
                )
            except (ValueError, TypeError):
                raise AppError("invalid_discovery_settings", "The Discovery settings are invalid.") from None
            settings["maxParallelFamilies"] = 1
            revision = previous["revision"] + 1
            owned = {
                k: v for k, v in settings.items() if k not in {"minFitScore", "autoApply", "applyApprovalRequired"}
            }
            conn.execute(
                "INSERT INTO discovery_settings VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
                (revision, json.dumps(owned, ensure_ascii=False)),
            )
            self.events.append(
                conn, "DiscoverySettingsUpdated", {"revision": revision}, feature="discovery", aggregate_id="settings"
            )
            result = self.read_settings(conn)
        return result

    def sources(self):
        with self.database.connect() as conn:
            result = []
            for row in conn.execute("SELECT * FROM discovery_sources ORDER BY state,source_id"):
                board = row["source_id"].removeprefix("jobstreaming:")
                if row["source_id"] != "jobstreaming:" + board or board not in self.boards:
                    continue
                source = {
                    **self._board_definition(board),
                    "sourceId": row["source_id"],
                    "state": row["state"],
                    "revision": row["revision"],
                    "updatedAt": row["updated_at"],
                }
                runs = conn.execute(
                    "SELECT * FROM discovery_source_runs WHERE source_id=? ORDER BY updated_at DESC LIMIT 100",
                    (row["source_id"],),
                ).fetchall()
                source["quality"] = {
                    "runCount": len(runs),
                    "failedRunCount": sum(r["status"] == "failed" for r in runs),
                    "observedJobs": sum(r["observed_jobs"] for r in runs),
                    "newJobs": sum(r["new_jobs"] for r in runs),
                    "lastRunId": runs[0]["run_id"] if runs else None,
                    "lastErrorClass": runs[0]["error_code"] if runs else None,
                    "recommendedState": row["state"],
                }
                failures = 0
                for source_run in runs:
                    if source_run["status"] != "failed":
                        break
                    failures += 1
                source.update(
                    {
                        "recommendedState": "normal" if row["state"] == "active" else row["state"],
                        "lastRunId": runs[0]["run_id"] if runs else None,
                        "lastRunCompletedAt": runs[0]["updated_at"] if runs else None,
                        "lastErrorClass": runs[0]["error_code"] if runs else None,
                        "consecutiveFailures": failures,
                        "observedJobs": sum(r["observed_jobs"] for r in runs),
                        "newJobs": sum(r["new_jobs"] for r in runs),
                        "duplicateRate": None,
                        "activeVerificationRate": None,
                        "fullDescriptionSuccessRate": None,
                        "applyUrlSuccessRate": None,
                        "qualityTrend": "unknown",
                    }
                )
                source["politeness"] = {
                    "robotsDisallowedCount": 0,
                    "rateLimitedCount": sum(
                        r["error_code"] in {BOARD_RATE_LIMIT_CODE, "rate_limited", "source_acquisition_deferred"} for r in runs
                    ),
                    "budgetExhaustedCount": sum(r["error_code"] == "source_budget_exhausted" for r in runs),
                    "lastBlockedReason": None,
                    "lastBlockedAt": None,
                }
                result.append(source)
        return {"ok": True, "sources": result}

    @staticmethod
    def _board_definition(board):
        return {
            "sourceId": "jobstreaming:" + board,
            "kind": "broad_board",
            "displayName": board,
            "owner": "system",
            "priority": "lead_generator",
            "policyId": "broad_board_lead_generator",
            "adapterConfig": {"board": board},
        }

    def source(self, source_id, *, connection=None):
        board = source_id.removeprefix("jobstreaming:")
        if source_id != "jobstreaming:" + board or board not in self.boards:
            raise NotFoundError("The JobStreaming board does not exist.")
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            row = conn.execute("SELECT state,revision FROM discovery_sources WHERE source_id=?", (source_id,)).fetchone()
        if row is None:
            raise NotFoundError("The JobStreaming board does not exist.")
        return {**self._board_definition(board), "state": row["state"], "revision": row["revision"]}

    def set_board_state(self, source_id, state, expected):
        if not isinstance(state, str) or state not in {"active", "experimental", "disabled", "quarantined"}:
            raise AppError("invalid_source_state", "Choose a valid board state.")
        with self.database.transaction() as conn:
            source = self.source(source_id, connection=conn)
            if type(expected) is not int or source["revision"] != expected:
                raise ConflictError()
            revision = expected + 1
            conn.execute("UPDATE discovery_sources SET revision=?,state=?,updated_at=? WHERE source_id=?",
                         (revision, state, now(), source_id))
            self.events.append(conn, "DiscoverySourceUpdated", {"sourceId": source_id, "revision": revision},
                               feature="discovery", aggregate_id=source_id)
            return {"ok": True, "source": {**source, "state": state, "revision": revision}}

    def seed_boards(self):
        with self.database.transaction() as conn:
            for board in self.boards:
                source = self._board_definition(board)
                conn.execute("INSERT OR IGNORE INTO discovery_sources VALUES(?,1,'active',?,?)",
                             (source["sourceId"], json.dumps(source), now()))

    def captures(self):
        with self.database.connect() as conn:
            return {
                "ok": True,
                "items": [
                    {
                        **json.loads(r["data_json"]),
                        "itemId": r["item_id"],
                        "lifecycleId": r["lifecycle_id"],
                        "generation": r["generation"],
                        "status": "pending" if r["state"] == "prepared" else r["state"],
                    }
                    for r in conn.execute(
                        "SELECT * FROM discovery_captures WHERE state IN ('pending','prepared') ORDER BY updated_at DESC"
                    )
                ],
            }

    def capture_item(self, item_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT * FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
        if not row:
            raise NotFoundError("The capture request does not exist.")
        return {
            **json.loads(row["data_json"]),
            "itemId": row["item_id"],
            "lifecycleId": row["lifecycle_id"],
            "generation": row["generation"],
            "status": row["state"],
        }

    def assert_capture_import_current(self, connection, item_id, generation, lifecycle_id, owner_token):
        row = connection.execute(
            "SELECT lifecycle_id,generation,state,data_json FROM discovery_captures WHERE item_id=?", (item_id,)
        ).fetchone()
        if (
            not row
            or row["lifecycle_id"] != lifecycle_id
            or row["generation"] != generation
            or row["state"] not in {"pending", "prepared"}
            or json.loads(row["data_json"]).get("importOwner", {}).get("token") != owner_token
        ):
            raise ConflictError("This capture request changed during extraction.")

    def transition_capture(self, item_id, action, *, lifecycle_id=None, job_id=None):
        states = {"prepare": "prepared", "import": "imported", "dismiss": "dismissed", "supersede": "pending"}
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
            if not row:
                raise NotFoundError()
            if lifecycle_id is not None and lifecycle_id != row["lifecycle_id"]:
                raise ConflictError("This capture request has been superseded.")
            if row["state"] not in {"pending", "prepared"} and action != "supersede":
                raise ConflictError("This capture has already been resolved.")
            data = json.loads(row["data_json"])
            if action in {"prepare", "supersede"}:
                for key in (
                    "submittedInputHash",
                    "captureProvenance",
                    "importOwner",
                    "jobId",
                    "importedAt",
                    "dismissedAt",
                ):
                    data.pop(key, None)
            if job_id:
                data["jobId"] = job_id
                data["importedAt"] = now()
            if action == "dismiss":
                data["dismissedAt"] = now()
            lifecycle = fingerprint(str(uuid4())) if action in {"prepare", "supersede"} else row["lifecycle_id"]
            generation = row["generation"] + int(action in {"prepare", "supersede"})
            conn.execute(
                "UPDATE discovery_captures SET lifecycle_id=?,generation=?,state=?,data_json=?,updated_at=? WHERE item_id=?",
                (lifecycle, generation, states[action], json.dumps(data), now(), item_id),
            )
            self.events.append(
                conn,
                "DiscoveryCaptureUpdated",
                {"itemId": item_id, "status": states[action]},
                feature="discovery",
                aggregate_id=item_id,
            )
        return {"ok": True, **self.capture_item(item_id)}

    def claim_capture_import(self, item_id, generation, lifecycle_id, input_hash, provenance):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
            if (
                not row
                or row["generation"] != generation
                or row["lifecycle_id"] != lifecycle_id
                or row["state"] not in {"pending", "prepared"}
            ):
                raise AppError(
                    "manual_capture_state_changed",
                    "The capture lifetime changed.",
                    409,
                    {"reason": "manual_capture_state_changed"},
                )
            data = json.loads(row["data_json"])
            if data.get("submittedInputHash") and data["submittedInputHash"] != input_hash:
                raise AppError(
                    "capture_replay_mismatch",
                    "Prepare a new capture lifetime before changing previously submitted content.",
                    409,
                    {"reason": "capture_replay_mismatch"},
                )
            owner = data.get("importOwner")
            if owner and owner.get("expiresAt", 0) > time.time():
                alive = True
                try:
                    os.kill(owner["pid"], 0)
                except ProcessLookupError:
                    alive = False
                except (PermissionError, KeyError, TypeError):
                    pass
                if alive:
                    raise AppError(
                        "manual_capture_in_progress",
                        "The submitted capture is still being processed.",
                        409,
                        {"reason": "manual_capture_in_progress"},
                    )
            token = str(uuid4())
            data.update(
                submittedInputHash=input_hash,
                captureProvenance=provenance,
                importOwner={"token": token, "pid": os.getpid(), "expiresAt": time.time() + 600},
            )
            conn.execute(
                "UPDATE discovery_captures SET data_json=?,updated_at=? WHERE item_id=?",
                (json.dumps(data), now(), item_id),
            )
        return token

    def release_capture_import(self, item_id, token):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT data_json FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
            if row:
                data = json.loads(row[0])
                if data.get("importOwner", {}).get("token") == token:
                    data.pop("importOwner", None)
                    conn.execute(
                        "UPDATE discovery_captures SET data_json=? WHERE item_id=?", (json.dumps(data), item_id)
                    )

    def complete_capture_import(
        self, item_id, generation, lifecycle_id, input_hash, provenance, job_id, token=None, connection=None
    ):
        from contextlib import nullcontext

        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
            if not row or row["generation"] != generation or row["lifecycle_id"] != lifecycle_id:
                raise AppError(
                    "manual_capture_state_changed",
                    "The capture lifetime changed after acceptance.",
                    409,
                    {"reason": "manual_capture_state_changed"},
                )
            data = json.loads(row["data_json"])
            if (
                data.get("submittedInputHash") != input_hash
                or token is not None
                and data.get("importOwner", {}).get("token") != token
            ):
                raise AppError(
                    "capture_replay_mismatch",
                    "The accepted capture does not match submitted input.",
                    409,
                    {"reason": "capture_replay_mismatch"},
                )
            data.update(jobId=job_id, importedAt=data.get("importedAt") or now(), captureProvenance=provenance)
            data.pop("importOwner", None)
            conn.execute(
                "UPDATE discovery_captures SET state='imported',data_json=?,updated_at=? WHERE item_id=?",
                (json.dumps(data), now(), item_id),
            )
            self.events.append(
                conn,
                "DiscoveryCaptureUpdated",
                {"itemId": item_id, "status": "imported", "jobId": job_id},
                feature="discovery",
                aggregate_id=item_id,
            )
            result = {
                **data,
                "itemId": item_id,
                "lifecycleId": lifecycle_id,
                "generation": generation,
                "status": "imported",
            }
        return {"ok": True, **result}

    def claim_run(self, run_id, request):
        request_hash, token, clock = fingerprint(request), str(uuid4()), time.time()
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_runs WHERE run_id=?", (run_id,)).fetchone()
            if row and row["request_hash"] != request_hash:
                raise ConflictError("The saved Discovery run has different inputs.")
            if row and row["cancel_requested"]:
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            if row and row["status"] in {"completed", "partial"}:
                return {"completed": True, "result": json.loads(row["result_json"])}
            # A retried durable activity takes a new epoch. Every admission and
            # cursor write checks that epoch, fencing an uncooperative old read.
            if row:
                conn.execute(
                    "UPDATE discovery_runs SET status='running',owner_token=?,epoch=epoch+1,lease_until=?,updated_at=?,failure_code=NULL WHERE run_id=?",
                    (token, clock + 120, now(), run_id),
                )
                epoch = row["epoch"] + 1
            else:
                conn.execute(
                    "INSERT INTO discovery_runs(run_id,status,request_hash,request_json,owner_token,epoch,lease_until,created_at,updated_at) VALUES(?,'running',?,?,?,1,?,?,?)",
                    (run_id, request_hash, json.dumps(request), token, clock + 120, now(), now()),
                )
                epoch = 1
            self.events.append(
                conn,
                "DiscoveryRunUpdated",
                {"runId": run_id, "status": "running"},
                feature="discovery",
                aggregate_id=run_id,
            )
        return {"completed": False, "run_id": run_id, "token": token, "epoch": epoch}

    def guard_run(self, conn, lease):
        row = conn.execute("SELECT * FROM discovery_runs WHERE run_id=?", (lease["run_id"],)).fetchone()
        if (
            row is None
            or row["owner_token"] != lease["token"]
            or row["epoch"] != lease["epoch"]
            or row["lease_until"] <= time.time()
        ):
            raise ConflictError("This Discovery execution no longer owns the run.")
        if row["cancel_requested"] or row["status"] != "running":
            raise AppError("action_cancelled", "Discovery was cancelled.", 409)
        return dict(row)

    def heartbeat(self, lease):
        with self.database.transaction() as conn:
            self.guard_run(conn, lease)
            conn.execute(
                "UPDATE discovery_runs SET lease_until=?,updated_at=? WHERE run_id=?",
                (time.time() + 120, now(), lease["run_id"]),
            )

    def cancel(self, run_id):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT status FROM discovery_runs WHERE run_id=?", (run_id,)).fetchone()
            if not row:
                raise NotFoundError()
            conn.execute(
                "UPDATE discovery_runs SET cancel_requested=1,status=CASE WHEN status='running' THEN 'cancelled' ELSE status END,updated_at=? WHERE run_id=?",
                (now(), run_id),
            )
            self.events.append(
                conn,
                "DiscoveryRunUpdated",
                {"runId": run_id, "status": "cancelled"},
                feature="discovery",
                aggregate_id=run_id,
            )
        return {"ok": True, "runId": run_id, "status": "cancelled"}

    def runs(self):
        with self.database.connect() as conn:
            return {
                "ok": True,
                "runs": [
                    {
                        "runId": r["run_id"],
                        "status": r["status"],
                        "newJobs": r["new_jobs"],
                        "observedJobs": r["observed_jobs"],
                        "failureCode": r["failure_code"],
                        "failures": [public_board_failure(failure) for failure in
                                     (json.loads(r["result_json"]) if r["result_json"] else {}).get("failures", [])],
                        "createdAt": r["created_at"],
                        "updatedAt": r["updated_at"],
                    }
                    for r in conn.execute("SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT 100")
                ],
            }

    def progress_summary(self, *, limit=100):
        with self.database.connect() as conn:
            result = []
            for run in conn.execute(
                "SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT ?", (max(1, min(100, limit)),)
            ):
                units = [
                    {
                        "unitId": unit["unit_id"],
                        "status": unit["status"],
                        "updatedAt": unit["updated_at"],
                        "sourceFamily": json.loads(unit["data_json"]).get("source_family", "unknown"),
                        "sourceId": json.loads(unit["data_json"]).get("source_id"),
                        "termination": (json.loads(unit["result_json"]) if unit["result_json"] else {}).get("termination"),
                    }
                    for unit in conn.execute(
                        "SELECT * FROM discovery_units WHERE run_id=? ORDER BY updated_at,unit_id", (run["run_id"],)
                    )
                ]
                sources = [
                    {
                        "sourceId": source["source_id"],
                        "status": source["status"],
                        "newJobs": source["new_jobs"],
                        "observedJobs": source["observed_jobs"],
                        "failureCode": source["error_code"],
                        "updatedAt": source["updated_at"],
                    }
                    for source in conn.execute(
                        "SELECT * FROM discovery_source_runs WHERE run_id=? ORDER BY source_id", (run["run_id"],)
                    )
                ]
                result.append(
                    {
                        "runId": run["run_id"],
                        "status": run["status"],
                        "executionEpoch": run["epoch"],
                        "newJobs": run["new_jobs"],
                        "observedJobs": run["observed_jobs"],
                        "createdAt": run["created_at"],
                        "updatedAt": run["updated_at"],
                        "failureCode": run["failure_code"],
                        "units": units,
                        "sources": sources,
                        "knownUnitCount": len(units),
                        "completedUnitCount": sum(unit["status"] == "completed" for unit in units),
                        "totalCompleteness": "recorded_units_only",
                    }
                )
        return {
            "runs": result,
            "observedAt": now(),
            "authority": "committed_discovery_records",
            "caveats": [
                "Unit totals include only units recorded by execution; unstarted source fan-out may add units.",
                "Recorded status and timestamps are not independent worker-liveness proof.",
            ],
        }

    def settle(self, lease, status, result=None, failure_code=None):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_runs WHERE run_id=?", (lease["run_id"],)).fetchone()
            if row is None or row["owner_token"] != lease["token"] or row["epoch"] != lease["epoch"]:
                raise ConflictError("The Discovery run has another owner.")
            if row["cancel_requested"]:
                status = "cancelled"
            if result is not None:
                result = {**result, "status": status, "ok": status == "completed" and result.get("ok", True)}
            conn.execute(
                "UPDATE discovery_runs SET status=?,owner_token=NULL,lease_until=0,result_json=?,failure_code=?,updated_at=? WHERE run_id=?",
                (status, json.dumps(result) if result else None, failure_code, now(), lease["run_id"]),
            )
            conn.execute(
                "UPDATE discovery_source_runs SET status=?,updated_at=? WHERE run_id=? AND status='running'",
                ("completed" if status in {"completed", "partial"} else status, now(), lease["run_id"]),
            )
            self.events.append(
                conn,
                "DiscoveryRunUpdated",
                {"runId": lease["run_id"], "status": status},
                feature="discovery",
                aggregate_id=lease["run_id"],
            )
        return status

    def finalize_bounded_units(self, lease, limit):
        """Recover fulfilled work across every source family before settlement.

        Reaching the shared admission limit ends unfinished acquisition, but
        does not establish provider completion. Preserve failed source state.
        """
        with self.database.transaction() as conn:
            run = self.guard_run(conn, lease)
            if run["new_jobs"] >= limit:
                failed_sources = {
                    row[0] for row in conn.execute(
                        "SELECT source_id FROM discovery_source_runs WHERE run_id=? AND status='failed'", (lease["run_id"],)
                    )
                }
                for row in conn.execute(
                    "SELECT unit_id,status,data_json FROM discovery_units WHERE run_id=? AND status IN ('running','waiting_for_query_turn')", (lease["run_id"],)
                ).fetchall():
                    data = json.loads(row["data_json"])
                    sources = {data["source_id"]} if data.get("source_id") else {"jobstreaming:" + board for board in data.get("sites", [])}
                    if row["status"] == "running" and sources.intersection(failed_sources):
                        continue
                    conn.execute(
                        "UPDATE discovery_units SET status='budget_exhausted',result_json=json_set(COALESCE(result_json,'{}'),'$.termination','budget_exhaustion'),updated_at=? WHERE run_id=? AND unit_id=?",
                        (now(), lease["run_id"], row["unit_id"]),
                    )
                conn.execute(
                    "UPDATE discovery_source_runs SET status='budget_exhausted',updated_at=? WHERE run_id=? AND status='running'",
                    (now(), lease["run_id"]),
                )
            fulfilled = conn.execute(
                "SELECT COUNT(*) FROM discovery_units WHERE run_id=? AND status IN ('completed','budget_exhausted')",
                (lease["run_id"],),
            ).fetchone()[0]
            failures = [
                {"sourceId": row["source_id"], "code": row["error_code"] or "discovery_source_failed"}
                for row in conn.execute(
                    "SELECT source_id,error_code FROM discovery_source_runs WHERE run_id=? AND status='failed' ORDER BY source_id",
                    (lease["run_id"],),
                )
            ]
            return {"fulfilledUnitCount": fulfilled, "failures": failures}

    def budget_remaining(self, lease, limit):
        with self.database.connect() as conn:
            run = self.guard_run(conn, lease)
            return max(0, int(limit) - run["new_jobs"])

    def board_new_jobs_by_query(self, lease):
        """Recover each query's share from the same commits that spent the run budget."""
        with self.database.connect() as conn:
            self.guard_run(conn, lease)
            return dict(conn.execute(
                """SELECT json_extract(u.data_json,'$.query'), COUNT(*)
                   FROM discovery_intake_receipts r JOIN discovery_units u
                     ON u.run_id=r.run_id AND u.unit_id=r.unit_id
                   WHERE r.run_id=? AND r.outcome='accepted' AND json_extract(r.data_json,'$.isNew')=1
                     AND json_extract(u.data_json,'$.source_family')='broad_boards'
                   GROUP BY json_extract(u.data_json,'$.query')""", (lease["run_id"],)
            ))

    def run_request(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT request_json FROM discovery_runs WHERE run_id=?", (run_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def run_outcome(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT result_json FROM discovery_runs WHERE run_id=?", (run_id,)).fetchone()
            return json.loads(row[0]) if row and row[0] else None

    def unit(self, run_id, unit_id):
        with self.database.connect() as conn:
            row = conn.execute(
                "SELECT * FROM discovery_units WHERE run_id=? AND unit_id=?", (run_id, unit_id)
            ).fetchone()
            return (
                {
                    "status": row["status"],
                    "data": json.loads(row["data_json"]),
                    "result": json.loads(row["result_json"]) if row["result_json"] else None,
                }
                if row
                else None
            )

    def save_unit(self, lease, unit, *, status, cursor=None, result=None, connection=None):
        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            self.guard_run(conn, lease)
            data = {**unit, "cursor": cursor}
            conn.execute(
                "INSERT INTO discovery_units VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,unit_id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,result_json=excluded.result_json,updated_at=excluded.updated_at",
                (
                    lease["run_id"],
                    unit["unit_id"],
                    status,
                    json.dumps(data),
                    json.dumps(result) if result else None,
                    now(),
                ),
            )

    def record_board_failure(self, lease, unit, error, *, board=None):
        """Persist the safe unit and source outcome together, before SDK acknowledgement."""
        with self.database.transaction() as conn:
            self.guard_run(conn, lease)
            row = conn.execute("SELECT status,result_json FROM discovery_units WHERE run_id=? AND unit_id=?",
                               (lease["run_id"], unit["unit_id"])).fetchone()
            result = json.loads(row["result_json"]) if row and row["result_json"] else {}
            if row and row["status"] == "failed" and "failure" in result:
                return result["failure"]
            boards = [board] if board else unit["sites"]
            diagnostic = error.details if error.code in {BOARD_RATE_LIMIT_CODE, "discovery_provider_authentication_configuration"} else None
            failure = {"sourceFamily": "broad_boards", "unitId": unit["unit_id"], "boards": boards,
                       "code": error.code, "message": error.message, **(diagnostic or {})}
            self.save_unit(lease, unit, status="failed", result={**result, "failure": failure}, connection=conn)
            for site in boards:
                self.source_result(lease, "jobstreaming:" + site, "failed", error_code=error.code, connection=conn)
            if diagnostic:
                self.events.append(conn, "DiscoveryRunUpdated", {"runId": lease["run_id"], "status": "running", "sourceFailure": failure},
                                   feature="discovery", aggregate_id=lease["run_id"], level="warn", stage="board_search")
            return failure

    def settled_intake(self, lease, key, limit, cancelled, connection=None):
        """Check the committed receipt and capacity before potentially paid qualification."""
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            run = self.guard_run(conn, lease)
            if cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            previous = conn.execute("SELECT job_id,outcome FROM discovery_intake_receipts WHERE receipt_key=?", (key,)).fetchone()
            at_limit = run["new_jobs"] >= limit
            if previous:
                return {"job_id": previous["job_id"], "outcome": previous["outcome"], "replayed": True,
                        "budget_reached": at_limit, "created": False}
            if at_limit:
                return {"job_id": None, "outcome": "budget_exhausted", "replayed": False, "budget_reached": True, "created": False}
            return None

    def role_call(self, owner, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            row = conn.execute("SELECT input_fingerprint,result_json FROM discovery_operations WHERE operation_id=? AND kind='role_target_call'",
                               (owner,)).fetchone()
            return {"input_fingerprint": row["input_fingerprint"], "receipt_id": json.loads(row["result_json"])} if row else None

    def bind_role_call(self, owner, expected, receipt_id, connection):
        connection.execute("INSERT INTO discovery_operations VALUES(?,'role_target_call',?,?,?)",
                           (owner, expected, json.dumps(receipt_id), now()))

    def waiting_for_role_capacity(self, lease, unit_id, reason):
        with self.database.transaction() as conn:
            self.guard_run(conn, lease)
            self.events.append(conn, "DiscoveryRoleTargetWaiting", {"runId": lease["run_id"], "unitId": unit_id, "reason": reason},
                               feature="discovery", aggregate_id=lease["run_id"], stage="role_target")

    def role_review(self, binding, *, decision=None, guard=None, connection=None):
        """Retain post-search judgments separately from the original intake outcome."""
        if connection is None:
            with self.database.transaction() if decision is not None else self.database.connect() as conn:
                return self.role_review(binding, decision=decision, guard=guard, connection=conn)
        identity = fingerprint(binding)
        operation = "role-target-review:" + identity
        if guard is not None:
            guard(connection)
        previous = connection.execute(
            "SELECT result_json FROM discovery_operations WHERE operation_id=? AND kind='role_target_review' AND input_fingerprint=?",
            (operation, identity),
        ).fetchone()
        if previous:
            return json.loads(previous["result_json"])["decision"]
        if decision is not None:
            connection.execute("INSERT INTO discovery_operations VALUES(?,'role_target_review',?,?,?)",
                               (operation, identity, json.dumps({"binding": binding, "decision": decision}), now()))
        return decision

    def accept_posting(self, lease, unit, posting, *, jobs, receipt_key, excluded=False, limit=None, cancelled=None,
                       role_target_decision=None, role_target_unavailable=None):
        with self.database.transaction() as conn:
            run = self.guard_run(conn, lease)
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            previous = conn.execute(
                "SELECT * FROM discovery_intake_receipts WHERE receipt_key=?", (receipt_key,)
            ).fetchone()
            if previous:
                return {"job_id": previous["job_id"], "outcome": previous["outcome"], "replayed": True, "budget_reached": limit is not None and run["new_jobs"] >= limit, "created": False}
            if limit is not None and run["new_jobs"] >= limit:
                return {"job_id": None, "outcome": "budget_exhausted", "replayed": False, "budget_reached": True, "created": False}
            outcome, saved = "filtered" if excluded else "accepted", None
            created = False
            if not excluded and (role_target_unavailable or role_target_decision and role_target_decision["verdict"] != "match"):
                raise AppError("discovery_role_admission_invalid", "The posting has no accepted role decision.", 409)
            if not excluded:
                saved = jobs.ingest(
                    {**posting, "run_id": lease["run_id"]},
                    receipt_key=receipt_key,
                    connection=conn,
                    guard=lambda current_conn: self.guard_run(current_conn, lease),
                )
                if saved.get("deleted"):
                    outcome = "operator_deleted"
                created = outcome == "accepted" and saved.get("capture_created") is True
                conn.execute(
                    "UPDATE discovery_runs SET new_jobs=new_jobs+?,observed_jobs=observed_jobs+1,updated_at=? WHERE run_id=?",
                    (int(created), now(), lease["run_id"]),
                )
                conn.execute(
                    "INSERT INTO discovery_source_runs VALUES(?,?,'running',?,?,NULL,?) ON CONFLICT(run_id,source_id) DO UPDATE SET new_jobs=discovery_source_runs.new_jobs+excluded.new_jobs,observed_jobs=discovery_source_runs.observed_jobs+1,updated_at=excluded.updated_at",
                    (
                        lease["run_id"],
                        posting["source_id"],
                        int(created),
                        1,
                        now(),
                    ),
                )
            evidence = {}
            if role_target_unavailable:
                evidence["roleTargetUnavailable"] = role_target_unavailable
            if role_target_decision:
                evidence["roleTargetMatch"] = role_target_decision
                if excluded:
                    evidence["roleTargetPosting"] = posting_role_evidence(posting)
                elif saved and not saved.get("deleted") and role_target_decision["postingEvidenceFingerprint"] == fingerprint(posting_role_evidence(saved)):
                    self.role_review(role_binding(lease["run_id"], saved, role_target_decision["targetPlanId"]),
                                     decision=role_target_decision, connection=conn)
            conn.execute(
                "INSERT INTO discovery_intake_receipts VALUES(?,?,?,?,?,?,?)",
                (
                    receipt_key,
                    lease["run_id"],
                    unit["unit_id"],
                    saved["job_id"] if saved else None,
                    outcome,
                    json.dumps(
                        {
                            "sourceId": posting.get("source_id"),
                            "sourceNativeId": posting.get("source_native_id"),
                            "isNew": created,
                            "postingRevision": saved["revision"] if saved else None,
                            "provenance": posting.get("provenance") if excluded else None,
                            **evidence,
                        }
                    ),
                    now(),
                ),
            )
            budget_reached = limit is not None and conn.execute(
                "SELECT new_jobs FROM discovery_runs WHERE run_id=?", (lease["run_id"],)
            ).fetchone()[0] >= limit
        return {"job_id": saved["job_id"] if saved else None, "outcome": outcome, "replayed": False, "budget_reached": budget_reached, "created": created}

    def run_job_ids(self, run_id):
        with self.database.connect() as conn:
            rows = conn.execute(
                "SELECT job_id,data_json FROM discovery_intake_receipts WHERE run_id=? AND job_id IS NOT NULL ORDER BY created_at,receipt_key",
                (run_id,),
            ).fetchall()
            role_counts = conn.execute(
                """SELECT COALESCE(json_extract(data_json,'$.roleTargetMatch.verdict'),
                                   json_extract(data_json,'$.roleTargetUnavailable.reason')) AS decision,
                          COUNT(*) AS observations
                   FROM discovery_intake_receipts WHERE run_id=? AND decision IS NOT NULL GROUP BY decision""",
                (run_id,),
            ).fetchall()
        return {
            "jobIds": list(dict.fromkeys(row["job_id"] for row in rows)),
            "newJobIds": list(
                dict.fromkeys(row["job_id"] for row in rows if json.loads(row["data_json"]).get("isNew"))
            ),
            **({"roleTargetObservations": {row["decision"]: row["observations"] for row in role_counts}} if role_counts else {}),
        }

    def observed_job(self, run_id, job_id):
        with self.database.connect() as conn:
            return conn.execute("SELECT 1 FROM discovery_intake_receipts WHERE run_id=? AND job_id=? LIMIT 1",
                                (run_id, job_id)).fetchone() is not None

    def source_result(self, lease, source_id, status, *, new_jobs=0, observed_jobs=0, error_code=None, connection=None):
        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            self.guard_run(conn, lease)
            conn.execute(
                "INSERT INTO discovery_source_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,source_id) DO UPDATE SET status=excluded.status,new_jobs=discovery_source_runs.new_jobs+excluded.new_jobs,observed_jobs=discovery_source_runs.observed_jobs+excluded.observed_jobs,error_code=excluded.error_code,updated_at=excluded.updated_at",
                (lease["run_id"], source_id, status, new_jobs, observed_jobs, error_code, now()),
            )

    def feedback(self, data):
        ident = str(uuid4())
        with self.database.transaction() as conn:
            conn.execute(
                "INSERT INTO discovery_feedback VALUES(?,?,?,?,?,?)",
                (
                    ident,
                    data.get("jobKey") or data.get("job_id"),
                    data.get("kind", "note"),
                    json.dumps(data, ensure_ascii=False),
                    now(),
                ),
            )
            self.events.append(
                conn,
                "DiscoveryFeedbackUpdated",
                {"feedbackId": ident, "jobId": data.get("jobKey")},
                feature="discovery",
                aggregate_id=ident,
            )
        return {"ok": True, "feedbackId": ident, **data, "recordedAt": now()}

    def feedback_sources(self, *, limit=100):
        with self.database.connect() as conn:
            rows = conn.execute(
                "SELECT feedback_id,data_json FROM discovery_feedback ORDER BY created_at DESC LIMIT ?",
                (min(100, max(1, limit)),),
            ).fetchall()
            return [{"source_id": row["feedback_id"], "text": row["data_json"]} for row in rows]

    def latest_target_plan(self):
        with self.database.connect() as conn:
            row = conn.execute(
                "SELECT data_json FROM discovery_target_plans ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return json.loads(row[0]) if row else None

    def target_plan_operation(self, operation_id):
        with self.database.connect() as conn:
            row = conn.execute(
                "SELECT data_json FROM discovery_target_plans WHERE json_extract(data_json,'$.operationId')=?",
                (operation_id,),
            ).fetchone()
            return json.loads(row[0]) if row else None

    def save_target_plan(self, accepted, assert_profile_current):
        with self.database.transaction() as conn:
            assert_profile_current(conn)
            conn.execute(
                "INSERT INTO discovery_target_plans VALUES(?,?,?,?,?) ON CONFLICT(plan_id) DO NOTHING",
                (
                    accepted["planId"],
                    accepted["profileRevision"],
                    accepted["profileFingerprint"],
                    now(),
                    json.dumps(accepted, ensure_ascii=False),
                ),
            )
            saved = json.loads(
                conn.execute(
                    "SELECT data_json FROM discovery_target_plans WHERE plan_id=?", (accepted["planId"],)
                ).fetchone()[0]
            )
            if saved.get("operationFingerprint") != accepted.get("operationFingerprint"):
                raise ConflictError("The saved target-plan operation belongs to different input.")
            self.events.append(
                conn,
                "DiscoveryTargetsUpdated",
                {"planId": saved["planId"], "profileRevision": saved["profileRevision"]},
                feature="discovery",
                aggregate_id="targets",
            )
        return saved

    def feedback_proposals(self, *, connection=None, suggestion_ids=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            return {
                "ok": True,
                "suggestions": [
                    {**json.loads(row["data_json"]), "suggestionId": row["suggestion_id"], "status": row["state"]}
                    for row in conn.execute("SELECT * FROM discovery_feedback_proposals ORDER BY created_at DESC")
                ],
            }

    def feedback_operation(self, operation_id, input_fingerprint, *, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            row = conn.execute("SELECT * FROM discovery_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if not row:
                return None
            if row["kind"] != "feedback_refresh" or row["input_fingerprint"] != input_fingerprint:
                raise ConflictError("This feedback refresh belongs to different input.")
            ids = set(json.loads(row["result_json"])["suggestionIds"])
            result = self.feedback_proposals(connection=conn)
            result["suggestions"] = [
                suggestion for suggestion in result["suggestions"] if suggestion["suggestionId"] in ids
            ]
            return result

    def save_feedback_proposals(self, proposals, *, operation_id=None, input_fingerprint=None):
        with self.database.transaction() as conn:
            if operation_id:
                replay = self.feedback_operation(operation_id, input_fingerprint, connection=conn)
                if replay:
                    return replay
            ids = []
            for proposal in proposals:
                ident = fingerprint({k: proposal[k] for k in ("ruleKind", "titlePattern")})
                conn.execute(
                    "INSERT INTO discovery_feedback_proposals VALUES(?,'pending',?,?,NULL) ON CONFLICT(suggestion_id) DO NOTHING",
                    (ident, json.dumps(proposal, ensure_ascii=False), now()),
                )
                ids.append(ident)
            if operation_id:
                conn.execute(
                    "INSERT INTO discovery_operations VALUES(?,'feedback_refresh',?,?,?)",
                    (operation_id, input_fingerprint, json.dumps({"suggestionIds": ids}), now()),
                )
            self.events.append(
                conn,
                "DiscoveryFeedbackUpdated",
                {"suggestionsChanged": True},
                feature="discovery",
                aggregate_id="feedback",
            )
            result = self.feedback_proposals(connection=conn)
            result["suggestions"] = [
                suggestion for suggestion in result["suggestions"] if suggestion["suggestionId"] in ids
            ]
        return result

    def decide_feedback(self, ident, decision, *, reason=None):
        if decision not in {"approve", "decline", "reject"}:
            raise AppError("invalid_feedback_decision", "Choose approve or decline.")
        state = "approved" if decision == "approve" else "declined"
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_feedback_proposals WHERE suggestion_id=?", (ident,)).fetchone()
            if not row:
                raise NotFoundError()
            if row["state"] not in {"pending", state}:
                raise ConflictError()
            data = {**json.loads(row["data_json"]), "decisionReason": reason}
            if state == "approved" and data.get("ruleKind") == "exact_title_exclusion":
                settings = self.read_settings(conn)
                exclusions = settings["settings"]["exactTitleExclusions"]
                if data["titlePattern"] not in exclusions:
                    self.save_settings(
                        {
                            "expectedRevision": settings["revision"],
                            "exactTitleExclusions": [*exclusions, data["titlePattern"]],
                        },
                        connection=conn,
                    )
                data["appliedFilter"] = {"kind": "exact_title_exclusion", "literal": data["titlePattern"]}
            conn.execute(
                "UPDATE discovery_feedback_proposals SET state=?,data_json=?,decided_at=? WHERE suggestion_id=?",
                (state, json.dumps(data), now(), ident),
            )
            self.events.append(
                conn,
                "DiscoveryFeedbackUpdated",
                {"suggestionId": ident, "status": state},
                feature="discovery",
                aggregate_id=ident,
            )
        return {"ok": True, "suggestion": {**data, "suggestionId": ident, "status": state}}
