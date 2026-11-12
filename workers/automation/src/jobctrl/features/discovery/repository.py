"""Feature-owned search controls and fenced durable execution."""

from __future__ import annotations

from contextlib import nullcontext
import json
import os
import time
from uuid import uuid4

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.features.discovery.coordinates import source_coordinate
from jobctrl.features.discovery.domain import DEFAULT_SETTINGS, fingerprint, now, validate_settings


class DiscoveryRepository:
    def __init__(self, database, events, settings=None):
        self.database, self.events, self.settings = database, events, settings

    def read_settings(self, connection=None):
        if connection is None:
            with self.database.connect() as conn:
                return self.read_settings(conn)
        row = connection.execute("SELECT revision,data_json FROM discovery_settings WHERE singleton=1").fetchone()
        settings = {**DEFAULT_SETTINGS, **(json.loads(row[1]) if row else {})}
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
                    "editable": k != "applyApprovalRequired",
                    "locked": k == "applyApprovalRequired",
                    "activation": "restart"
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
                    "editable": k != "applyApprovalRequired",
                    "locked": k == "applyApprovalRequired",
                    "activation": "restart"
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
                source = {
                    **json.loads(row["data_json"]),
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
                        r["error_code"] in {"rate_limited", "source_acquisition_deferred"} for r in runs
                    ),
                    "budgetExhaustedCount": sum(r["error_code"] == "source_budget_exhausted" for r in runs),
                    "lastBlockedReason": None,
                    "lastBlockedAt": None,
                }
                result.append(source)
        return {"ok": True, "sources": result}

    def source(self, source_id, *, connection=None):
        if connection is not None:
            row = connection.execute("SELECT * FROM discovery_sources WHERE source_id=?", (source_id,)).fetchone()
        else:
            with self.database.connect() as conn:
                row = conn.execute("SELECT * FROM discovery_sources WHERE source_id=?", (source_id,)).fetchone()
        if row is None:
            raise NotFoundError("The Discovery source does not exist.")
        return {
            **json.loads(row["data_json"]),
            "sourceId": source_id,
            "state": row["state"],
            "revision": row["revision"],
        }

    def upsert_source(self, data, *, connection=None, preserve_state=False):
        from contextlib import nullcontext

        source_id = data.get("sourceId") or data.get("source_id")
        if not isinstance(source_id, str) or not source_id.strip() or len(source_id) > 500:
            raise AppError("invalid_source", "A source ID is required.")
        if data.get("seedUrl"):
            if source_coordinate(data["seedUrl"]) is None:
                raise AppError("invalid_source_url", "A public source URL is required.") from None
        state = data.get("state", "active")
        if state not in {"active", "experimental", "disabled", "quarantined"}:
            raise AppError("invalid_source_state", "Choose a valid source state.")
        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_sources WHERE source_id=?", (source_id,)).fetchone()
            if row and preserve_state:
                return {"ok": True, "source": self.source(source_id, connection=conn)}
            if row and data.get("createOnly") is True:
                raise ConflictError("That source ID already exists; review it before changing its configuration.")
            expected = data.get("expectedRevision")
            if row and expected is None and not preserve_state:
                raise AppError(
                    "expected_revision_required", "Supply the saved source revision before changing it.", 428
                )
            if row and expected is not None and expected != row["revision"]:
                raise ConflictError()
            saved = {
                "kind": "ats_api",
                "displayName": source_id,
                "owner": "user",
                "priority": "standard",
                "policyId": "ats_api_canonical",
                "adapterConfig": {},
                **(json.loads(row["data_json"]) if row else {}),
                **data,
            }
            if row and preserve_state:
                state = row["state"]
            revision = row["revision"] + 1 if row else 1
            saved.pop("expectedRevision", None)
            saved.pop("createOnly", None)
            conn.execute(
                "INSERT INTO discovery_sources VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,data_json=excluded.data_json,updated_at=excluded.updated_at",
                (source_id, revision, state, json.dumps(saved, ensure_ascii=False), now()),
            )
            self.events.append(
                conn,
                "DiscoverySourceUpdated",
                {"sourceId": source_id, "revision": revision},
                feature="discovery",
                aggregate_id=source_id,
            )
        return {"ok": True, "source": self.source(source_id, connection=connection)}

    def seed_boards(self):
        from jobctrl.features.discovery.defaults import packaged_sources

        with self.database.transaction() as conn:
            for board in DEFAULT_SETTINGS["boards"]:
                source_id = "jobstreaming:" + board
                if not conn.execute("SELECT 1 FROM discovery_sources WHERE source_id=?", (source_id,)).fetchone():
                    self.upsert_source(
                        {
                            "sourceId": source_id,
                            "kind": "broad_board",
                            "displayName": board,
                            "owner": "system",
                            "priority": "lead_generator",
                            "policyId": "broad_board_lead_generator",
                            "adapterConfig": {"board": board},
                        },
                        connection=conn,
                    )
            for source in packaged_sources():
                if not conn.execute(
                    "SELECT 1 FROM discovery_sources WHERE source_id=?", (source["sourceId"],)
                ).fetchone():
                    self.upsert_source(source, connection=conn)

    def proposals(self):
        sources = self.sources()["sources"]
        with self.database.connect() as conn:
            candidates = []
            for row in conn.execute("SELECT * FROM discovery_candidates ORDER BY updated_at DESC"):
                data = json.loads(row["data_json"])
                data.update(
                    candidateId=row["candidate_id"],
                    candidateUrl=row["coordinate"],
                    decision=row["decision"],
                    revision=row["revision"],
                    discoveredAt=row["created_at"],
                )
                data["origins"] = [
                    json.loads(e[0])
                    for e in conn.execute(
                        "SELECT data_json FROM discovery_candidate_evidence WHERE candidate_id=? ORDER BY created_at",
                        (row["candidate_id"],),
                    )
                ]
                data["overlaps"] = [
                    {"sourceId": s["sourceId"], "state": s["state"], "seedUrl": s.get("seedUrl")}
                    for s in sources
                    if s["sourceId"] == data.get("sourceId")
                    or s.get("seedUrl")
                    and source_coordinate(s["seedUrl"]) is not None
                    and source_coordinate(s["seedUrl"]).url == row["coordinate"]
                ]
                data["employerDomainMatched"], data["manualActionReason"] = False, None
                data["proposal"] = {
                    "coordinateKey": row["coordinate"],
                    "sourceId": data["sourceId"],
                    "atsKind": data.get("detectedAtsKind"),
                    "boardToken": data.get("boardToken"),
                    "completeness": "unknown",
                    "promotionBlockedReason": data.get("promotionBlockedReason"),
                    "evidence": data["origins"],
                    "overlaps": data["overlaps"],
                }
                candidates.append(data)
        return {"ok": True, "candidates": candidates}

    def propose_source(self, url, evidence):
        coordinate = source_coordinate(url)
        if coordinate is None:
            return {"status": "invalid", "candidateId": None}
        with self.database.transaction() as conn:
            existing = conn.execute(
                "SELECT * FROM discovery_candidates WHERE coordinate=?", (coordinate.url,)
            ).fetchone()
            if existing and existing["decision"] == "reject":
                return {"status": "suppressed", "candidateId": existing["candidate_id"]}
            if existing and existing["decision"] == "promote":
                return {"status": "unchanged", "candidateId": existing["candidate_id"]}
            configured_workday = None
            if coordinate.ats_kind == "workday":
                for registry in conn.execute("SELECT source_id,data_json FROM discovery_sources"):
                    entry = json.loads(registry["data_json"])
                    seed = source_coordinate(entry.get("seedUrl") or "")
                    config = entry.get("adapterConfig") or {}
                    if (
                        seed is not None
                        and seed.url == coordinate.url
                        and all(config.get(key) for key in ("base_url", "tenant", "site_id"))
                    ):
                        configured_workday = registry["source_id"]
                        break
            data = {
                "sourceId": configured_workday or coordinate.source_id,
                "sourceKind": "ats_api" if coordinate.ats_kind else "employer_careers_page",
                "detectedAtsKind": coordinate.ats_kind,
                "boardToken": coordinate.board_token,
                "completeness": "unknown",
                "proposalOnly": True,
                "confidence": 1.0 if coordinate.ats_kind else 0.0,
                "promotionBlockedReason": "workday_requires_configured_employer"
                if coordinate.ats_kind == "workday" and configured_workday is None
                else "regional_lever_adapter_unsupported"
                if coordinate.source_id.startswith("lever:eu:")
                else None,
            }
            ident = existing["candidate_id"] if existing else coordinate.candidate_id
            receipt_id = fingerprint([ident, evidence])
            if (
                existing
                and existing["decision"] == "pending"
                and json.loads(existing["data_json"]) == data
                and conn.execute(
                    "SELECT 1 FROM discovery_candidate_evidence WHERE evidence_id=?", (receipt_id,)
                ).fetchone()
            ):
                return {"status": "unchanged", "candidateId": ident}
            conn.execute(
                "INSERT INTO discovery_candidates VALUES(?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET decision='pending',revision=discovery_candidates.revision+1,data_json=excluded.data_json,updated_at=excluded.updated_at",
                (ident, coordinate.url, "pending", 1, json.dumps(data), now(), now()),
            )
            conn.execute(
                "INSERT INTO discovery_candidate_evidence VALUES(?,?,?,?) ON CONFLICT(evidence_id) DO NOTHING",
                (receipt_id, ident, json.dumps(evidence, ensure_ascii=False), now()),
            )
            self.events.append(
                conn, "SourceProposalUpdated", {"candidateId": ident}, feature="discovery", aggregate_id=ident
            )
        return {"status": "proposed", "candidateId": ident}

    def decide_proposal(self, candidate_id, decision, expected_revision=None):
        if decision not in {"promote", "reject", "reset"}:
            raise AppError("invalid_source_decision", "Choose promote, reject or reset.")
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            if row is None:
                raise NotFoundError("The source proposal does not exist.")
            if expected_revision is not None and expected_revision != row["revision"]:
                raise ConflictError()
            data = json.loads(row["data_json"])
            source = None
            if decision == "promote":
                if row["decision"] == "reject":
                    raise ConflictError("Reset the rejected coordinate before explicitly promoting it.")
                if data.get("promotionBlockedReason"):
                    raise AppError("source_promotion_blocked", data["promotionBlockedReason"], 409)
                overlap = conn.execute(
                    "SELECT state FROM discovery_sources WHERE source_id=?", (data["sourceId"],)
                ).fetchone()
                if overlap and overlap[0] in {"disabled", "quarantined", "paused"}:
                    raise ConflictError("The overlapping source is disabled; change its state explicitly first.")
                source = self.upsert_source(
                    {
                        "sourceId": data["sourceId"],
                        "seedUrl": row["coordinate"],
                        "kind": data["sourceKind"],
                        "adapterConfig": {"atsKind": data.get("detectedAtsKind"), "board": data.get("boardToken")},
                    },
                    connection=conn,
                    preserve_state=True,
                )["source"]
            conn.execute(
                "UPDATE discovery_candidates SET decision=?,revision=revision+1,updated_at=? WHERE candidate_id=?",
                (decision, now(), candidate_id),
            )
            self.events.append(
                conn,
                "SourceProposalUpdated",
                {"candidateId": candidate_id, "decision": decision},
                feature="discovery",
                aggregate_id=candidate_id,
            )
        return {"ok": True, "candidateId": candidate_id, "decision": decision, "source": source, "decidedAt": now()}

    def require_capture(self, url, *, source_id=None, reason="manual_capture_required", retry_context=None):
        item_id = "capture:" + fingerprint([url, source_id])[:32]
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM discovery_captures WHERE item_id=?", (item_id,)).fetchone()
            if not row:
                data = {
                    "originatingUrl": url,
                    "sourceId": source_id,
                    "reason": reason,
                    "retryContext": retry_context or {},
                    "requiredAt": now(),
                }
                conn.execute(
                    "INSERT INTO discovery_captures VALUES(?,?,1,'pending',?,?)",
                    (item_id, fingerprint(str(uuid4())), json.dumps(data), now()),
                )
                self.events.append(
                    conn, "DiscoveryCaptureUpdated", {"itemId": item_id}, feature="discovery", aggregate_id=item_id
                )
        return item_id

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
                        "failures": (json.loads(r["result_json"]) if r["result_json"] else {}).get("failures", []),
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
                    "SELECT unit_id,data_json FROM discovery_units WHERE run_id=? AND status='running'", (lease["run_id"],)
                ).fetchall():
                    data = json.loads(row["data_json"])
                    sources = {data["source_id"]} if data.get("source_id") else {"jobstreaming:" + board for board in data.get("sites", [])}
                    if sources.intersection(failed_sources):
                        continue
                    conn.execute(
                        "UPDATE discovery_units SET status='budget_exhausted',updated_at=? WHERE run_id=? AND unit_id=?",
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

    def run_request(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT request_json FROM discovery_runs WHERE run_id=?", (run_id,)).fetchone()
            return json.loads(row[0]) if row else None

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

    def save_unit(self, lease, unit, *, status, cursor=None, result=None):
        with self.database.transaction() as conn:
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

    def accept_posting(self, lease, unit, posting, *, jobs, receipt_key, excluded=False, limit=None, cancelled=None):
        with self.database.transaction() as conn:
            run = self.guard_run(conn, lease)
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            previous = conn.execute(
                "SELECT * FROM discovery_intake_receipts WHERE receipt_key=?", (receipt_key,)
            ).fetchone()
            if previous:
                return {"job_id": previous["job_id"], "outcome": previous["outcome"], "replayed": True}
            outcome, saved = "filtered" if excluded else "accepted", None
            if not excluded:
                current = jobs.resolve_posting(posting, connection=conn)
                if current is None and limit is not None and run["new_jobs"] >= limit:
                    return {"job_id": None, "outcome": "budget_exhausted", "replayed": False}
                saved = jobs.ingest(
                    {**posting, "run_id": lease["run_id"]},
                    receipt_key=receipt_key,
                    connection=conn,
                    guard=lambda current_conn: self.guard_run(current_conn, lease),
                )
                if saved.get("deleted"):
                    outcome = "operator_deleted"
                conn.execute(
                    "UPDATE discovery_runs SET new_jobs=new_jobs+?,observed_jobs=observed_jobs+1,updated_at=? WHERE run_id=?",
                    (int(saved.get("capture_created") is True and not saved.get("deleted")), now(), lease["run_id"]),
                )
                conn.execute(
                    "INSERT INTO discovery_source_runs VALUES(?,?,'running',?,?,NULL,?) ON CONFLICT(run_id,source_id) DO UPDATE SET new_jobs=discovery_source_runs.new_jobs+excluded.new_jobs,observed_jobs=discovery_source_runs.observed_jobs+1,updated_at=excluded.updated_at",
                    (
                        lease["run_id"],
                        posting["source_id"],
                        int(saved.get("capture_created") is True and not saved.get("deleted")),
                        1,
                        now(),
                    ),
                )
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
                            "isNew": saved.get("capture_created") is True if saved else False,
                            "postingRevision": saved["revision"] if saved else None,
                            "provenance": posting.get("provenance") if excluded else None,
                        }
                    ),
                    now(),
                ),
            )
        return {"job_id": saved["job_id"] if saved else None, "outcome": outcome, "replayed": False}

    def run_job_ids(self, run_id):
        with self.database.connect() as conn:
            rows = conn.execute(
                "SELECT job_id,data_json FROM discovery_intake_receipts WHERE run_id=? AND job_id IS NOT NULL ORDER BY created_at,receipt_key",
                (run_id,),
            ).fetchall()
        return {
            "jobIds": list(dict.fromkeys(row["job_id"] for row in rows)),
            "newJobIds": list(
                dict.fromkeys(row["job_id"] for row in rows if json.loads(row["data_json"]).get("isNew"))
            ),
        }

    def source_result(self, lease, source_id, status, *, new_jobs=0, observed_jobs=0, error_code=None):
        with self.database.transaction() as conn:
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
