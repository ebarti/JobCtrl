"""Jobs' PostgreSQL adapter: one canonical writer for all intake paths."""

from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.features.jobs.domain.postings import canonical_posting, digest, identity_keys, utc_now


class PostgresJobsRepository:
    def __init__(self, database, events):
        self.database, self.events = database, events
        self.deletion_ports = []
        self.post_commit_deletion_ports = []

    def register_deletion_port(self, callback):
        if callback not in self.deletion_ports:
            self.deletion_ports.append(callback)

    def register_post_commit_deletion_port(self, callback, feature=None):
        registered = (callback, feature)
        if registered not in self.post_commit_deletion_ports:
            self.post_commit_deletion_ports.append(registered)

    def _snapshot(self, conn, job_id, *, include_deleted=False):
        row = conn.execute(
            "SELECT j.*,p.data_json,EXISTS(SELECT 1 FROM jobs_quarantine q WHERE q.job_id=j.job_id AND q.state='pending') AS quarantined FROM jobs_jobs j JOIN jobs_postings p "
            "ON p.job_id=j.job_id AND p.revision=j.revision WHERE j.job_id=?",
            (job_id,),
        ).fetchone()
        if row is None or row["deleted_at"] is not None and not include_deleted:
            raise NotFoundError("The saved job does not exist.")
        return {
            **json.loads(row["data_json"]),
            "job_id": row["job_id"],
            "revision": row["revision"],
            "source_revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "hidden": row["hidden_at"] is not None,
            "deleted": row["deleted_at"] is not None,
            "state_revision": row["state_revision"],
            "quarantined": bool(row["quarantined"]),
        }

    def snapshot(self, job_id, *, connection=None, include_deleted=False):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            return self._snapshot(conn, job_id, include_deleted=include_deleted)

    def snapshots(self, job_ids, *, connection=None, include_deleted=False):
        ids = list(dict.fromkeys(job_ids))
        if len(ids) > 1000 or not all(isinstance(job_id, str) for job_id in ids):
            raise AppError("invalid_job_batch", "Read at most 1,000 saved jobs per batch.")
        if not ids:
            return {}
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            rows = conn.execute(
                "SELECT j.*,p.data_json,EXISTS(SELECT 1 FROM jobs_quarantine q WHERE q.job_id=j.job_id AND q.state='pending') AS quarantined "
                "FROM jobs_jobs j JOIN jobs_postings p ON p.job_id=j.job_id AND p.revision=j.revision "
                "WHERE j.job_id IN ("
                + ",".join("?" for _ in ids)
                + ")"
                + ("" if include_deleted else " AND j.deleted_at IS NULL"),
                ids,
            ).fetchall()
            mapped = {
                row["job_id"]: {
                    **json.loads(row["data_json"]),
                    "job_id": row["job_id"],
                    "revision": row["revision"],
                    "source_revision": row["revision"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "hidden": row["hidden_at"] is not None,
                    "deleted": row["deleted_at"] is not None,
                    "state_revision": row["state_revision"],
                    "quarantined": bool(row["quarantined"]),
                }
                for row in rows
            }
            return {job_id: mapped[job_id] for job_id in ids if job_id in mapped}

    def assert_current(self, job_id, revision, source_hash=None, *, connection=None):
        snapshot = self.snapshot(job_id, connection=connection)
        if snapshot["revision"] != revision or source_hash is not None and snapshot["source_hash"] != source_hash:
            raise ConflictError(
                "The posting changed while this action was running.",
                job_id=job_id,
                expected_revision=revision,
                current_revision=snapshot["revision"],
            )
        return snapshot

    def resolve_url(self, url, *, connection=None):
        from jobctrl.features.jobs.domain.postings import normalize_url

        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            row = conn.execute(
                "SELECT job_id FROM jobs_identity_keys WHERE identity_key=?", ("url:" + normalize_url(url),)
            ).fetchone()
            return self._snapshot(conn, row[0], include_deleted=True) if row else None

    def resolve_posting(self, data, *, connection=None):
        keys = identity_keys(canonical_posting(data))
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            owners = {
                row[0]
                for key in keys
                for row in conn.execute("SELECT job_id FROM jobs_identity_keys WHERE identity_key=?", (key,))
            }
            if len(owners) > 1:
                raise ConflictError("Posting identity points to different saved jobs.")
            return self._snapshot(conn, next(iter(owners)), include_deleted=True) if owners else None

    def capture_receipt(self, receipt_key, *, expected_fingerprint=None, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            row = conn.execute(
                "SELECT job_id,posting_revision,receipt_fingerprint,observation_id,provenance_json FROM jobs_observations WHERE receipt_key=?",
                (receipt_key,),
            ).fetchone()
            if not row:
                return None
            if expected_fingerprint is not None and row["receipt_fingerprint"] != expected_fingerprint:
                raise ConflictError("This capture receipt belongs to different input.")
            current = self._snapshot(conn, row["job_id"], include_deleted=True)
            posting = conn.execute(
                "SELECT data_json FROM jobs_postings WHERE job_id=? AND revision=?",
                (row["job_id"], row["posting_revision"]),
            ).fetchone()
            if not posting:
                raise ConflictError("The capture receipt is missing its immutable posting revision.")
            return {
                **current,
                **json.loads(posting[0]),
                "revision": row["posting_revision"],
                "source_revision": row["posting_revision"],
                "observation_id": row["observation_id"],
                "capture_provenance": json.loads(row["provenance_json"]),
            }

    def capture(
        self,
        data,
        *,
        expected_revision=None,
        job_id=None,
        receipt_key=None,
        receipt_fingerprint=None,
        guard=None,
        on_accepted=None,
        connection=None,
        discovery_observation=False,
        existing_only=False,
    ):
        incoming = canonical_posting(data)
        receipt_fingerprint = receipt_fingerprint or digest(data)
        keys = identity_keys(incoming)
        timestamp = utc_now()
        with nullcontext(connection) if connection is not None else self.database.transaction() as conn:
            if guard:
                guard(conn)
            if receipt_key:
                receipt = self.capture_receipt(receipt_key, expected_fingerprint=receipt_fingerprint, connection=conn)
                if receipt:
                    return receipt
            owners = {
                row[0]
                for key in keys
                for row in conn.execute("SELECT job_id FROM jobs_identity_keys WHERE identity_key=?", (key,))
            }
            if job_id:
                owners.add(job_id)
            if len(owners) > 1:
                raise ConflictError("Posting identity points to different saved jobs; review the source identity.")
            existing_id = next(iter(owners), None)
            previous = self._snapshot(conn, existing_id, include_deleted=True) if existing_id else None
            if existing_only and previous is None:
                return None
            if previous and expected_revision is not None and previous["revision"] != expected_revision:
                raise ConflictError(
                    "The posting changed before the capture was saved.", current_revision=previous["revision"]
                )
            if job_id and previous is None:
                raise NotFoundError("The job to refresh does not exist.")
            if previous and previous["deleted"]:
                # Discovery cannot restore an operator-deleted job implicitly.
                return previous
            job_id = existing_id or str(uuid4())
            if not previous:
                conn.execute(
                    "INSERT INTO jobs_jobs(job_id,created_at,updated_at) VALUES(?,?,?)", (job_id, timestamp, timestamp)
                )
            if previous and (
                existing_only
                or discovery_observation and previous["content_state"] == "accepted_detail"
                and incoming["content_state"] != "accepted_detail"
                or previous["description"] and not incoming["description"]
            ):
                # Record the observation without replacing the accepted posting.
                accepted = previous
                changed = False
            elif (
                previous
                and expected_revision is None
                and datetime.fromisoformat(incoming["observed_at"]) < datetime.fromisoformat(previous["observed_at"])
            ):
                accepted, changed = previous, False
            else:
                accepted = incoming
                changed = previous is None or previous["source_hash"] != incoming["source_hash"]
            revision = (previous["revision"] if previous else 0) + int(changed)
            if changed:
                conn.execute(
                    "INSERT INTO jobs_postings VALUES(?,?,?,?,?,?)",
                    (
                        job_id,
                        revision,
                        accepted["source_id"],
                        accepted["source_hash"],
                        accepted["observed_at"],
                        json.dumps(accepted, ensure_ascii=False),
                    ),
                )
                conn.execute(
                    "UPDATE jobs_jobs SET revision=?,updated_at=? WHERE job_id=?", (revision, timestamp, job_id)
                )
                conn.execute(
                    "UPDATE jobs_quarantine SET state='superseded',reviewed_at=? WHERE job_id=? AND state='pending' AND expected_revision<?",
                    (timestamp, job_id, revision),
                )
            for key in keys:
                conn.execute(
                    "INSERT INTO jobs_identity_keys VALUES(?,?,?) ON CONFLICT(identity_key) DO NOTHING",
                    (key, job_id, timestamp),
                )
            observation_id = str(uuid4())
            conn.execute(
                "INSERT INTO jobs_observations(observation_id,job_id,source_id,source_native_id,observed_url,observed_at,"
                "run_id,receipt_key,provenance_json,posting_revision,receipt_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    observation_id,
                    job_id,
                    incoming["source_id"],
                    incoming["source_native_id"],
                    incoming["url"],
                    incoming["observed_at"],
                    data.get("run_id"),
                    receipt_key,
                    json.dumps(incoming["provenance"], ensure_ascii=False),
                    revision,
                    receipt_fingerprint if receipt_key else None,
                ),
            )
            self.events.append(
                conn,
                "JobCaptured" if previous is None else "JobSourceObserved",
                {
                    "jobId": job_id,
                    "revision": revision,
                    "observationId": observation_id,
                    "sourceId": incoming["source_id"],
                    "postingChanged": changed,
                },
                feature="jobs",
                aggregate_id=job_id,
            )
            result = {
                **self._snapshot(conn, job_id),
                "capture_created": previous is None,
                "observation_id": observation_id,
                "capture_provenance": incoming["provenance"],
            }
            if on_accepted:
                on_accepted(conn, result)
            return result

    def list(self, filters=None, *, connection=None, ids_only=False):
        filters = filters or {}
        clauses, values = [], []
        if not filters.get("include_deleted") and filters.get("status") not in {"deleted", "all"}:
            clauses.append("j.deleted_at IS NULL")
        elif filters.get("status") == "deleted":
            clauses.append("j.deleted_at IS NOT NULL")
        if filters.get("status") == "hidden":
            clauses.append("j.hidden_at IS NOT NULL")
        elif not filters.get("include_hidden") and filters.get("status") != "all":
            clauses.append("j.hidden_at IS NULL")
        if filters.get("since"):
            since = str(filters["since"])
            if "\0" in since:
                clauses.append("FALSE")
            else:
                clauses.append("CASE WHEN pg_input_is_valid(?, 'timestamptz') THEN j.created_at::timestamptz>?::text::timestamptz END")
                values.extend((since, since))
        search = filters.get("q") or filters.get("query") or filters.get("search")
        literal = str(search).casefold() if search else None
        fields = ("title", "company", "location", "url", "source_id")
        limit = max(1, min(1000, int(filters.get("limit") or 100)))
        offset = max(0, int(filters.get("offset") or 0))
        sort = {"discoveredAt": "created_at", "discovered_at": "created_at"}.get(
            filters.get("sort"), filters.get("sort")
        ) or "created_at"
        posting_sort = sort in {"title", "company", "location", "salary", "source_id", "active_state"}
        if sort in {"created_at", "updated_at", "revision"}:
            order = "j." + sort
        elif posting_sort:
            order = f"lower((p.data_json::jsonb ->> '{sort}') COLLATE \"C\")"
        else:
            raise AppError("invalid_job_sort", "Choose a supported saved-job sort field.")
        direction = str(filters.get("direction") or filters.get("sortDirection") or "desc").lower()
        if direction not in {"asc", "desc"}:
            raise AppError("invalid_job_sort", "Choose ascending or descending sorting.")
        base = " FROM jobs_jobs j JOIN jobs_postings p ON p.job_id=j.job_id AND p.revision=j.revision"
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            if (literal is not None or posting_sort) and (
                literal is not None and "\0" in literal
                or conn.execute(
                    "SELECT 1" + base + where + (" AND " if where else " WHERE ")
                    + "NOT pg_input_is_valid(p.data_json, 'jsonb') LIMIT 1", values,
                ).fetchone()
            ):
                # PostgreSQL jsonb cannot project an escaped zero even if that
                # character lives in an unrelated free-text field. Preserve
                # exact retained text when filtering this exceptional result set.
                candidates = conn.execute(
                    "SELECT j.job_id,j.created_at,j.updated_at,j.revision,p.data_json" + base + where, values,
                )
                job_ids, total = self._list_unqueryable_postings(
                    candidates, literal, fields, sort, posting_sort, direction, limit, offset,
                )
            else:
                if literal is not None:
                    clauses.append("(" + " OR ".join(
                        f"strpos(lower((p.data_json::jsonb ->> '{field}') COLLATE \"C\"),?)>0" for field in fields
                    ) + ")")
                    values.extend([literal] * len(fields))
                    where = " WHERE " + " AND ".join(clauses)
                total = conn.execute("SELECT count(*)" + base + where, values).fetchone()[0]
                rows = conn.execute(
                    "SELECT j.job_id" + base + where + " ORDER BY " + order + " " + direction
                    + (" NULLS FIRST" if direction == "asc" else " NULLS LAST")
                    + ",j.job_id LIMIT ? OFFSET ?",
                    (*values, limit, offset),
                )
                job_ids = [row[0] for row in rows]
            if ids_only:
                return {"job_ids": job_ids, "total": total, "offset": offset, "limit": limit}
            jobs = [self._snapshot(conn, job_id, include_deleted=True) for job_id in job_ids]
        return {"jobs": jobs, "total": total, "offset": offset, "limit": limit}

    @staticmethod
    def _list_unqueryable_postings(candidates, literal, fields, sort, posting_sort, direction, limit, offset):
        ascii_lower = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
        matches = []
        for row in candidates:
            data = json.loads(row["data_json"])
            if literal is not None and not any(literal in (data.get(field) or "").translate(ascii_lower)
                                               for field in fields):
                continue
            value = data.get(sort) if posting_sort else row[sort]
            if posting_sort and value is not None:
                value = value.translate(ascii_lower)
            matches.append((row["job_id"], value))
        matches.sort(key=lambda row: row[0])
        matches.sort(key=lambda row: (row[1] is not None, row[1]), reverse=direction == "desc")
        return [row[0] for row in matches[offset:offset + limit]], len(matches)

    def history(self, job_id):
        with self.database.connect() as conn:
            self._snapshot(conn, job_id)
            snapshots = [
                {
                    **json.loads(row["data_json"]),
                    "revision": row["revision"],
                    "source_revision": row["revision"],
                    "job_id": job_id,
                }
                for row in conn.execute("SELECT * FROM jobs_postings WHERE job_id=? ORDER BY revision DESC", (job_id,))
            ]
            observations = [
                {**dict(row), "provenance": json.loads(row["provenance_json"])}
                for row in conn.execute(
                    "SELECT observation_id,job_id,source_id,source_native_id,observed_url,observed_at,run_id,receipt_key,"
                    "provenance_json,posting_revision,receipt_fingerprint FROM jobs_observations WHERE job_id=? ORDER BY observed_at DESC",
                    (job_id,)
                )
            ]
            attempts = [
                {**dict(row), "data": json.loads(row["data_json"])}
                for row in conn.execute(
                    "SELECT attempt_id,job_id,url,started_at,finished_at,state,failure_code,data_json FROM jobs_capture_attempts "
                    "WHERE job_id=? ORDER BY started_at DESC LIMIT 100", (job_id,)
                )
            ]
        return {"snapshots": snapshots, "observations": observations, "attempts": attempts}

    def availability(self, job_id, *, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            current = self._snapshot(conn, job_id)
            observations = conn.execute(
                """SELECT o.observation_id,o.observed_at,o.observed_url,o.posting_revision,o.provenance_json,
                          p.observed_at AS posting_observed_at,p.data_json
                   FROM jobs_observations o JOIN jobs_postings p
                     ON p.job_id=o.job_id AND p.revision=o.posting_revision
                   WHERE o.job_id=? AND (o.posting_revision=? OR o.observed_url=?)
                   ORDER BY o.observed_at::timestamptz DESC,o.insertion_order DESC""",
                (job_id, current["revision"], current["url"]),
            )
            attempts = conn.execute(
                """SELECT started_at,data_json FROM jobs_capture_attempts WHERE job_id=? AND url=?
                   ORDER BY started_at::timestamptz DESC,insertion_order DESC""",
                (job_id, current["url"]),
            )
            last_attempt = next((
                {"at": at, "outcome": "failed"} for at, data in attempts
                if json.loads(data).get("operation") == "availability"
            ), None)
            last_confirmed = latest = None
            for observed in observations:
                provenance = json.loads(observed["provenance_json"])
                availability = provenance.get("availability")
                when = datetime.fromisoformat(observed["observed_at"])
                identity = (when, observed["observation_id"])
                if isinstance(availability, dict) and observed["posting_revision"] == current["revision"]:
                    if latest is None or identity > latest[0]:
                        latest = (identity, observed["observed_at"], availability)
                if observed["observed_url"] != current["url"] or last_confirmed is not None:
                    continue
                # Profile edits, listing guesses and copied observations do
                # not renew the verification time of the exact captured URL.
                reported_at = None
                if isinstance(availability, dict) and isinstance(availability.get("metadata"), dict):
                    if availability["metadata"].get("requested_url") == observed["observed_url"]:
                        timestamp = availability.get("observedAt")
                        if isinstance(timestamp, str):
                            try:
                                reported_at = datetime.fromisoformat(timestamp)
                                if reported_at.tzinfo is None:
                                    reported_at = reported_at.replace(tzinfo=timezone.utc)
                            except ValueError:
                                pass
                interpreted = (
                    "availability" not in provenance and provenance.get("authority") == "source_bound_model"
                    and isinstance(provenance.get("pageInterpretation"), dict)
                    and observed["posting_observed_at"] == observed["observed_at"]
                )
                if reported_at != when and not interpreted:
                    continue
                outcome = availability.get("state") if isinstance(availability, dict) else None
                if outcome is None:
                    outcome = json.loads(observed["data_json"]).get("active_state")
                outcome = outcome or "unknown"
                if last_attempt is None or when > datetime.fromisoformat(last_attempt["at"]):
                    last_attempt = {"at": observed["observed_at"], "outcome": outcome}
                if outcome != "unknown":
                    last_confirmed = {"at": observed["observed_at"], "state": outcome}
            return {
                "job_id": job_id,
                "revision": current["revision"],
                "active_state": current["active_state"],
                "last_confirmed": last_confirmed,
                "last_attempt": last_attempt,
                "observation_id": latest[0][1] if latest else None,
                "checked_at": latest[1] if latest else None,
                "availability": latest[2] if latest else current.get("provenance", {}).get("availability"),
            }

    def create_delete_selection(self, job_ids=None, filters=None):
        with self.database.transaction() as conn:
            if job_ids is None:
                query = {**(filters or {}), "status": "deleted", "include_hidden": True, "limit": 1000}
                jobs, offset = [], 0
                while True:
                    page = self.list({**query, "offset": offset}, connection=conn)
                    jobs.extend(page["jobs"])
                    offset += len(page["jobs"])
                    if offset >= page["total"] or not page["jobs"]:
                        break
            else:
                jobs = [self._snapshot(conn, job_id, include_deleted=True) for job_id in dict.fromkeys(job_ids)]
            if not jobs or any(not job["deleted"] for job in jobs):
                raise ConflictError("Select deleted jobs for permanent removal.")
            selection = [
                {"job_id": job["job_id"], "revision": job["revision"], "state_revision": job["state_revision"]}
                for job in jobs
            ]
            ident, created = str(uuid4()), datetime.now(timezone.utc)
            conn.execute(
                "INSERT INTO jobs_delete_selections VALUES(?,?,?,NULL,?)",
                (ident, created.isoformat(), (created + timedelta(minutes=15)).isoformat(), json.dumps(selection)),
            )
        return {
            "ok": True,
            "selectionId": ident,
            "jobIds": [job["job_id"] for job in jobs],
            "count": len(jobs),
            "jobs": [
                {
                    "job_id": job["job_id"],
                    "title": job["title"],
                    "company": job["company"],
                    "revision": job["revision"],
                    "state_revision": job["state_revision"],
                }
                for job in jobs
            ],
            "retentionNotice": "This removes the selected Jobs and their job-owned records. Requirements used only by those Jobs and their links are permanently removed. Shared requirements, Profile facts and approved wording, independently saved learning plans and cohorts, company research, source-review history, and model audit history remain.",
            "retainedIndependentData": [
                "learning_plans_and_cohorts",
                "company_research_history",
                "source_review_history",
                "model_audit_history",
            ],
            "expiresAt": (created + timedelta(minutes=15)).isoformat(),
        }

    def set_visibility(
        self,
        job_ids,
        action,
        *,
        expected_revision=None,
        expected_state_revision=None,
        expected_revisions=None,
        expected_state_revisions=None,
        selection_id=None,
    ):
        if action not in {"hide", "unhide", "delete", "restore", "permanent-delete"}:
            raise AppError("invalid_job_action", "Unknown job action.")
        changed = []
        replayed = False
        with self.database.transaction() as conn:
            if action == "permanent-delete":
                if not selection_id:
                    raise AppError(
                        "reviewed_selection_required",
                        "Review the exact permanent-delete selection before confirming.",
                        409,
                    )
                selected = conn.execute(
                    "SELECT * FROM jobs_delete_selections WHERE selection_id=?", (selection_id,)
                ).fetchone()
                if not selected:
                    raise ConflictError("The reviewed deletion selection does not exist.")
                saved = json.loads(selected["selection_json"])
                selected_ids = {job["job_id"] for job in saved}
                if job_ids and set(job_ids) != selected_ids:
                    raise ConflictError("The confirmed deletion does not match the reviewed selection.")
                replayed = selected["consumed_at"] is not None
                if not replayed and datetime.fromisoformat(selected["expires_at"]) <= datetime.now(timezone.utc):
                    raise ConflictError("The reviewed deletion selection expired.")
                job_ids = [] if replayed else [job["job_id"] for job in saved]
                if replayed:
                    changed = [job["job_id"] for job in saved]
                for job in saved if not replayed else []:
                    current = self._snapshot(conn, job["job_id"], include_deleted=True)
                    if (
                        current["revision"] != job["revision"]
                        or current["state_revision"] != job["state_revision"]
                        or not current["deleted"]
                    ):
                        raise ConflictError("A reviewed job changed; review the deletion selection again.")
            for job_id in dict.fromkeys(job_ids):
                current = self._snapshot(conn, job_id, include_deleted=True)
                if expected_revision is not None and current["revision"] != expected_revision:
                    raise ConflictError()
                if expected_state_revision is not None and current["state_revision"] != expected_state_revision:
                    raise ConflictError()
                if expected_revisions is not None and (
                    job_id not in expected_revisions or expected_revisions[job_id] != current["revision"]
                ):
                    raise ConflictError("A selected posting changed.", job_id=job_id)
                if expected_state_revisions is not None and (
                    job_id not in expected_state_revisions
                    or expected_state_revisions[job_id] != current["state_revision"]
                ):
                    raise ConflictError("A selected job's visibility changed.", job_id=job_id)
                if action == "permanent-delete":
                    if not current["deleted"]:
                        raise ConflictError("Move the job to deleted items before permanently deleting it.")
                    for callback in self.deletion_ports:
                        try:
                            callback(job_id, connection=conn)
                        except AppError:
                            raise
                        except Exception as error:
                            code = getattr(error, "code", None)
                            if (
                                getattr(error, "conflict", False) is True
                                and isinstance(code, str)
                                and 0 < len(code) <= 160
                                and all(
                                    character.islower() or character.isdigit() or character == "_" for character in code
                                )
                            ):
                                message = {
                                    "application_submission_history_protected": "Application submission history protects this job from permanent deletion.",
                                    "application_run_active": "An application action still owns this job; wait for its safe settlement before permanent deletion.",
                                }.get(
                                    code,
                                    "A dependent feature requires review before this job can be permanently deleted.",
                                )
                                raise AppError(code, message, 409, {"jobId": job_id}) from None
                            raise
                    conn.execute("DELETE FROM jobs_operations WHERE (result_json::jsonb ->> 'job_id')=?", (job_id,))
                    conn.execute("DELETE FROM jobs_capture_attempts WHERE job_id=?", (job_id,))
                    conn.execute("DELETE FROM jobs_quarantine WHERE job_id=?", (job_id,))
                    conn.execute("DELETE FROM jobs_jobs WHERE job_id=?", (job_id,))
                else:
                    column = "hidden_at" if action in {"hide", "unhide"} else "deleted_at"
                    value = None if action in {"unhide", "restore"} else utc_now()
                    conn.execute(
                        f"UPDATE jobs_jobs SET {column}=?,updated_at=?,state_revision=state_revision+1 WHERE job_id=?",
                        (value, utc_now(), job_id),
                    )
                self.events.append(
                    conn, "JobUpdated", {"jobId": job_id, "action": action}, feature="jobs", aggregate_id=job_id
                )
                changed.append(job_id)
            if action == "permanent-delete" and not replayed:
                conn.execute(
                    "UPDATE jobs_delete_selections SET consumed_at=? WHERE selection_id=?", (utc_now(), selection_id)
                )
        result = {"ok": True, "jobIds": changed, "affected": len(changed)}
        if action == "permanent-delete":
            cleanup = []
            for callback, feature in self.post_commit_deletion_ports:
                try:
                    receipt = callback(changed)
                    if not isinstance(receipt, dict) or receipt.get("status") not in {"complete", "pending"}:
                        receipt = {"status": "pending", "code": "cleanup_receipt_invalid"}
                except Exception:
                    receipt = {"status": "pending", "code": "post_commit_cleanup_failed"}
                cleanup.append({**({"feature": feature} if feature else {}), **receipt})
            result.update(
                deletionCommitted=True,
                replayed=replayed,
                cleanupReceipts=cleanup,
                cleanupPending=any(receipt["status"] == "pending" for receipt in cleanup),
            )
        return result

    def record_attempt(self, *, job_id=None, url, failure_code=None, data=None, state="failed"):
        with self.database.transaction() as conn:
            attempt_id, now = str(uuid4()), utc_now()
            conn.execute(
                "INSERT INTO jobs_capture_attempts(attempt_id,job_id,url,started_at,finished_at,state,failure_code,data_json) VALUES(?,?,?,?,?,?,?,?)",
                (
                    attempt_id,
                    job_id,
                    url,
                    now,
                    now,
                    state,
                    failure_code,
                    json.dumps(data or {}, ensure_ascii=False),
                ),
            )
            self.events.append(
                conn,
                "JobCaptureAttempted",
                {"jobId": job_id, "attemptId": attempt_id, "state": state, "failureCode": failure_code},
                feature="jobs",
                aggregate_id=job_id or attempt_id,
            )
        return attempt_id

    def quarantine(self, data, *, job_id=None, expected_revision=None, reason):
        with self.database.transaction() as conn:
            ident = str(uuid4())
            conn.execute(
                "INSERT INTO jobs_quarantine VALUES(?,?,?,?,?,?,?,?)",
                (
                    ident,
                    job_id,
                    expected_revision,
                    reason,
                    "pending",
                    utc_now(),
                    None,
                    json.dumps(data, ensure_ascii=False),
                ),
            )
            self.events.append(
                conn,
                "PostingQuarantined",
                {"jobId": job_id, "quarantineId": ident, "reason": reason},
                feature="jobs",
                aggregate_id=job_id or ident,
            )
        return ident

    def list_quarantine(self):
        with self.database.connect() as conn:
            return [
                {**dict(row), "posting": json.loads(row["data_json"])}
                for row in conn.execute("SELECT * FROM jobs_quarantine WHERE state='pending' ORDER BY created_at")
            ]

    def decide_quarantine(self, quarantine_id, decision):
        if decision not in {"approve", "reject", "discard"}:
            raise AppError("invalid_quarantine_decision", "Choose approve or reject.")
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM jobs_quarantine WHERE quarantine_id=?", (quarantine_id,)).fetchone()
            if row is None:
                raise NotFoundError("The quarantined posting does not exist.")
            if row["state"] != "pending":
                raise ConflictError("This posting has already been reviewed.")
            result = None
            if decision == "approve":
                data = json.loads(row["data_json"])
                data["provenance"] = {
                    **data.get("provenance", {}),
                    "operatorContentOverride": {"quarantineId": quarantine_id, "reviewedAt": utc_now()},
                }
                result = self.capture(
                    data, job_id=row["job_id"], expected_revision=row["expected_revision"], connection=conn
                )
            conn.execute(
                "UPDATE jobs_quarantine SET state=?,reviewed_at=?,job_id=coalesce(?,job_id) WHERE quarantine_id=?",
                (decision, utc_now(), result["job_id"] if result else None, quarantine_id),
            )
            self.events.append(
                conn,
                "PostingQuarantineReviewed",
                {
                    "quarantineId": quarantine_id,
                    "decision": decision,
                    "jobId": result["job_id"] if result else row["job_id"],
                },
                feature="jobs",
                aggregate_id=quarantine_id,
            )
        return {"ok": True, "decision": decision, "posting": result}

    def analysis(self, job_id, *, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            current = self._snapshot(conn, job_id)
            row = conn.execute(
                "SELECT * FROM jobs_analysis WHERE job_id=? ORDER BY revision DESC LIMIT 1", (job_id,)
            ).fetchone()
            if row is None:
                return {"job_id": job_id, "accepted": None, "current": False}
            return {
                "job_id": job_id,
                "revision": row["revision"],
                "posting_revision": row["posting_revision"],
                "source_hash": row["source_hash"],
                "accepted": json.loads(row["data_json"]),
                "created_at": row["created_at"],
                "current": row["posting_revision"] == current["revision"]
                and row["source_hash"] == current["source_hash"],
            }

    def save_analysis(self, posting, result, *, cancelled=None):
        with self.database.transaction() as conn:
            if result.get("operation_id"):
                replay = self.analysis_operation(
                    result["operation_id"], result["operation_fingerprint"], connection=conn
                )
                if replay:
                    return replay
            self.assert_current(posting["job_id"], posting["revision"], posting["source_hash"], connection=conn)
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Role analysis was cancelled.", 409)
            last = conn.execute(
                "SELECT max(revision) FROM jobs_analysis WHERE job_id=?", (posting["job_id"],)
            ).fetchone()[0]
            revision = (last or 0) + 1
            conn.execute(
                "INSERT INTO jobs_analysis VALUES(?,?,?,?,?,?)",
                (
                    posting["job_id"],
                    revision,
                    posting["revision"],
                    posting["source_hash"],
                    utc_now(),
                    json.dumps(result, ensure_ascii=False),
                ),
            )
            self.events.append(
                conn,
                "JobAnalysisUpdated",
                {"jobId": posting["job_id"], "analysisRevision": revision, "postingRevision": posting["revision"]},
                feature="jobs",
                aggregate_id=posting["job_id"],
            )
            saved = {
                "job_id": posting["job_id"],
                "revision": revision,
                "posting_revision": posting["revision"],
                "source_hash": posting["source_hash"],
                "accepted": result,
                "created_at": utc_now(),
                "current": True,
            }
            if result.get("operation_id"):
                self._record_analysis_operation(conn, result["operation_id"], result["operation_fingerprint"], saved)
        return saved

    def _record_analysis_operation(self, conn, operation_id, input_fingerprint, analysis):
        conn.execute(
            "INSERT INTO jobs_operations VALUES(?,'analysis',?,?,?)",
            (
                operation_id,
                input_fingerprint,
                json.dumps({"job_id": analysis["job_id"], "analysis_revision": analysis["revision"]}),
                utc_now(),
            ),
        )

    def bind_analysis_operation(self, operation_id, input_fingerprint, posting, analysis):
        with self.database.transaction() as conn:
            previous = self.analysis_operation(operation_id, input_fingerprint, connection=conn)
            if previous:
                return previous
            self.assert_current(posting["job_id"], posting["revision"], posting["source_hash"], connection=conn)
            self._record_analysis_operation(conn, operation_id, input_fingerprint, analysis)
        return analysis

    def analysis_operation(self, operation_id, operation_fingerprint, *, connection=None):
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            operation = conn.execute("SELECT * FROM jobs_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if not operation:
                return None
            if operation["kind"] != "analysis" or operation["input_fingerprint"] != operation_fingerprint:
                raise ConflictError("This role-analysis operation belongs to different input.")
            binding = json.loads(operation["result_json"])
            row = conn.execute(
                "SELECT * FROM jobs_analysis WHERE job_id=? AND revision=?",
                (binding["job_id"], binding["analysis_revision"]),
            ).fetchone()
            if not row:
                raise ConflictError("The role-analysis receipt is missing its immutable accepted artifact.")
            accepted = json.loads(row["data_json"])
            current = self._snapshot(conn, row["job_id"])
            return {
                "job_id": row["job_id"],
                "revision": row["revision"],
                "posting_revision": row["posting_revision"],
                "source_hash": row["source_hash"],
                "created_at": row["created_at"],
                "accepted": accepted,
                "current": row["posting_revision"] == current["revision"]
                and row["source_hash"] == current["source_hash"],
            }
