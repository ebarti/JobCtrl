"""Read-only pipeline evidence composed through explicit public owner ports."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Protocol

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError

RUN_LIMIT = 100
DISPLAY_LIMIT = 20
EVENT_LIMIT = 5000
DISCOVERY_RUN_LIMIT = 10
HISTORY_DAYS = 30
MINIMUM_SAMPLES = 3
TERMINAL = frozenset({"succeeded", "skipped", "warning", "failed", "cancelled", "blocked"})
COMPLETED = frozenset({"succeeded", "skipped", "warning"})
STATUSES = ("pending", "running", "succeeded", "failed", "cancelled", "skipped", "warning", "blocked")


class PreparationReadPort(Protocol):
    def telemetry_runs(self, limit: int = 100) -> dict: ...
    def telemetry_run(self, run_id: str) -> dict: ...


class ActionReadPort(Protocol):
    def action_run(self, run_id: str) -> dict: ...
    def run_summary(self) -> dict: ...
    def worker_status(self) -> dict: ...


class EventReadPort(Protocol):
    def page(self, **filters) -> dict: ...


class LaneReadPort(Protocol):
    def lane_status(self) -> dict: ...


class SettingsReadPort(Protocol):
    def snapshot(self) -> dict: ...


class DiscoveryReadPort(Protocol):
    def progress_summary(self, limit: int = 100) -> dict: ...


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def _read(function, *args, **kwargs):
    try:
        value = function(*args, **kwargs)
        if not isinstance(value, dict):
            raise ValueError("invalid_public_snapshot")
        return {"available": True, **value}
    except Exception:
        # Public failures never turn into empty successful work or private text.
        return {"available": False, "errorCode": "telemetry_source_unavailable"}


def _counts(rows):
    result = dict.fromkeys(STATUSES, 0)
    result.update(Counter(row["status"] for row in rows))
    return result


class PipelineTelemetry:
    def __init__(
        self,
        *,
        actions: ActionReadPort,
        events: EventReadPort,
        model: LaneReadPort,
        settings: SettingsReadPort,
        preparation: PreparationReadPort | None = None,
        discovery: DiscoveryReadPort | None = None,
    ):
        self.actions, self.events, self.model, self.settings = actions, events, model, settings
        self.preparation, self.discovery = preparation, discovery

    def _history(self, runs, horizon):
        since = _iso(horizon - timedelta(days=HISTORY_DAYS))
        before, records, complete = None, [], False
        try:
            while len(records) < EVENT_LIMIT:
                page = self.events.page(
                    feature="preparation",
                    event_type="PreparationUpdated",
                    before=before,
                    limit=min(1000, EVENT_LIMIT - len(records)),
                    since=since,
                    until=_iso(horizon),
                )
                records.extend(page["events"])
                if not page["hasMore"]:
                    complete = True
                    break
                cursor = page["nextCursor"]
                if cursor is None or before is not None and int(cursor) >= before:
                    raise ValueError("invalid_event_cursor")
                before = int(cursor)
        except Exception:
            return (
                {},
                {},
                {
                    "available": False,
                    "since": since,
                    "until": _iso(horizon),
                    "eventCount": 0,
                    "complete": False,
                    "caveats": ["Recorded stage timing events are unavailable."],
                },
            )
        owners = {run["runId"]: run for run in runs}
        starts, latest, samples, restarted = {}, {}, defaultdict(list), set()
        exclusions = Counter()
        for event in sorted(records, key=lambda row: int(row["eventId"])):
            payload = event.get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("stage"), str):
                continue
            run_id = payload.get("runId")
            if (
                event.get("aggregateId") != run_id
                or event.get("feature") != "preparation"
                or event.get("type") != "PreparationUpdated"
                or event.get("stage") not in {None, payload["stage"]}
            ):
                exclusions["event_identity_mismatch"] += 1
                continue
            owner = owners.get(run_id)
            if owner is None:
                exclusions["run_metadata_outside_history"] += 1
                continue
            stage, job_id, status = payload["stage"], payload.get("jobId"), payload.get("status")
            plan = next((row for row in owner.get("stagePlan", []) if row["stage"] == stage), None)
            if (
                plan is None
                or (plan["scope"] == "run" and job_id is not None)
                or (plan["scope"] == "job" and (not owner.get("cohortFrozen") or job_id not in owner["jobIds"]))
            ):
                exclusions["stage_or_cohort_identity_unbound"] += 1
                continue
            key = (run_id, job_id, stage)
            latest[key] = event
            if status == "running":
                if key in starts:
                    restarted.add(key)
                    exclusions["superseded_running_start"] += 1
                starts[key] = event
                latest[key] = {**event, "unclosedPreviousStart": key in restarted}
                continue
            if status not in TERMINAL:
                continue
            start = starts.pop(key, None)
            was_restarted = key in restarted
            restarted.discard(key)
            if start is None:
                exclusions["terminal_without_recorded_start"] += 1
                continue
            begin, end = _time(start.get("occurredAt")), _time(event.get("occurredAt"))
            if begin is None or end is None or end <= begin or end > horizon:
                exclusions["invalid_or_zero_resolution_duration"] += 1
                continue
            if status != "succeeded" or was_restarted:
                exclusions["non_success_or_interrupted_attempt"] += 1
                continue
            samples[(owner["recipe"], stage, plan["scope"])].append(
                {
                    "runId": run_id,
                    "jobId": job_id,
                    "startEventId": start["eventId"],
                    "endEventId": event["eventId"],
                    "seconds": round((end - begin).total_seconds(), 6),
                }
            )
        caveats = [
            "Timing joins literal stage, scope, recipe, run and job identities from committed events.",
            "Only positive, successful, uninterrupted attempts are duration samples.",
            "Provider/model changes, content complexity and external waits are not normalized.",
            "Durations use recorded UTC wall-clock timestamps, not CPU time or a monotonic execution timer.",
        ]
        if not complete:
            caveats.append(
                "The bounded event window may omit older attempts; unmatched starts or completions are excluded."
            )
        return (
            samples,
            latest,
            {
                "available": True,
                "since": since,
                "until": _iso(horizon),
                "eventCount": len(records),
                "complete": complete,
                "excluded": dict(exclusions),
                "openStartCount": len(starts),
                "caveats": caveats,
            },
        )

    @staticmethod
    def _duration(samples):
        values = [row["seconds"] for row in samples]
        return {
            "sampleCount": len(values),
            "minimumSeconds": min(values) if values else None,
            "medianSeconds": median(values) if values else None,
            "maximumSeconds": max(values) if values else None,
            "samples": samples[-5:],
            "caveats": [
                f"A remaining-time estimate needs at least {MINIMUM_SAMPLES} matching samples per remaining stage.",
                "Observed ranges are historical samples, not confidence bounds or deadlines.",
            ],
        }

    @staticmethod
    def _eta(run, stages, action, latest, horizon):
        base = {
            "available": False,
            "lowerSeconds": None,
            "upperSeconds": None,
            "sampleCount": 0,
            "basis": "matching_recipe_stage_successful_elapsed_range",
            "caveats": [],
        }
        if run["status"] == "succeeded":
            return {
                **base,
                "available": True,
                "lowerSeconds": 0,
                "upperSeconds": 0,
                "basis": "recorded_completed_cohort",
                "caveats": ["The recorded cohort has completed; this is not a forecast."],
            }
        reason = None
        if run["status"] != "running":
            reason = "This cohort needs a new admitted run or explicit retry; no completion is currently scheduled."
        elif not run.get("cohortFrozen"):
            reason = "The cohort is not frozen; the remaining number of jobs is unknown."
        elif run.get("jobConcurrency") != 1:
            reason = "The public execution plan does not establish sequential work."
        elif action is None or action.get("status") != "running":
            reason = "The action is not recorded running; queue wait and admission time are unknown."
        if reason:
            return {**base, "caveats": [reason]}
        for step in run["steps"]:
            event = latest.get((run["runId"], step.get("jobId"), step["stage"]))
            if event and event["payload"].get("status") != step["status"]:
                return {
                    **base,
                    "caveats": [
                        "The event and checkpoint snapshots advanced during collection; reload before estimating."
                    ],
                }
        lower, upper, used = 0.0, 0.0, []
        running_count = 0
        for stage in stages:
            counts = stage["statusCounts"]
            if counts["failed"] or counts["cancelled"] or counts["blocked"] or set(counts) - set(STATUSES):
                return {
                    **base,
                    "caveats": ["A stage is failed, cancelled, blocked or has an unsupported recorded status."],
                }
            total = stage["expectedCount"]
            if total is None:
                return {**base, "caveats": ["The expected stage task count is unavailable."]}
            remaining = total - sum(counts[status] for status in COMPLETED)
            if remaining <= 0:
                continue
            stats = stage["duration"]
            if stats["sampleCount"] < MINIMUM_SAMPLES:
                return {
                    **base,
                    "sampleCount": sum(used),
                    "caveats": [f"Insufficient matching recorded durations for {stage['stage']}."],
                }
            used.append(stats["sampleCount"])
            lo, hi = stats["minimumSeconds"], stats["maximumSeconds"]
            lower += remaining * lo
            upper += remaining * hi
            for step in run["steps"]:
                if step["stage"] != stage["stage"] or step["status"] != "running":
                    continue
                running_count += 1
                event = latest.get((run["runId"], step.get("jobId"), stage["stage"]))
                if event and event.get("unclosedPreviousStart"):
                    return {
                        **base,
                        "caveats": [
                            "The running stage has an unclosed earlier start; interrupted attempt timing is uncertain."
                        ],
                    }
                start = (
                    _time(event.get("occurredAt")) if event and event["payload"].get("status") == "running" else None
                )
                if start is None or horizon < start:
                    return {**base, "caveats": ["The current running stage has no matching recorded start."]}
                elapsed = (horizon - start).total_seconds()
                if elapsed >= hi:
                    return {
                        **base,
                        "sampleCount": sum(used),
                        "caveats": ["The running stage has reached or exceeded its observed historical range."],
                    }
                lower -= min(elapsed, lo)
                upper -= min(elapsed, hi)
        if running_count > 1:
            return {**base, "caveats": ["Recorded simultaneous stages conflict with the sequential execution plan."]}
        if not stages or lower == 0 and upper == 0:
            return {
                **base,
                "caveats": ["No remaining timed stage work is established while the cohort is still running."],
            }
        return {
            **base,
            "available": True,
            "lowerSeconds": round(lower, 3),
            "upperSeconds": round(upper, 3),
            "sampleCount": sum(used),
            "caveats": [
                "Conditional on the recorded sequential recipe continuing without pause, failure or retry.",
                "Remaining declared stages may be skipped by their owners; this estimate assumes they execute.",
                "Historical minimum/maximum elapsed times are not statistical confidence bounds or guarantees.",
                "Provider/model, job complexity and current external contention may differ.",
            ],
        }

    def _cohort(self, run, samples, latest, horizon):
        action = _read(self.actions.action_run, run["runId"])
        action = (
            {key: action.get(key) for key in ("runId", "workflowId", "status", "updatedAt", "cancellationRequested")}
            if action["available"]
            else None
        )
        stages, caveats = [], []
        plan = {row["stage"]: row for row in run.get("stagePlan", [])}
        for step in run["steps"]:
            if step["stage"] not in plan:
                plan[step["stage"]] = {
                    "stage": step["stage"],
                    "scope": "run" if step.get("jobId") is None else "job",
                    "unplanned": True,
                }
        for stage, entry in plan.items():
            rows = [
                step
                for step in run["steps"]
                if step["stage"] == stage
                and (
                    entry["scope"] == "run"
                    and step.get("jobId") is None
                    or entry["scope"] == "job"
                    and (not run.get("cohortFrozen") or step.get("jobId") in run["jobIds"])
                )
            ]
            total = (
                None
                if entry.get("unplanned")
                else 1
                if entry["scope"] == "run"
                else len(run["jobIds"])
                if run.get("cohortFrozen")
                else None
            )
            if total is not None and len(rows) > total:
                total = None
                caveats.append(f"Recorded {stage} rows exceed its declared cohort scope; backlog is unavailable.")
            running = []
            for step in rows:
                if step["status"] != "running":
                    continue
                event = latest.get((run["runId"], step.get("jobId"), stage))
                start = (
                    _time(event.get("occurredAt")) if event and event["payload"].get("status") == "running" else None
                )
                running.append(
                    {
                        "jobId": step.get("jobId"),
                        "recordedStartAt": event["occurredAt"] if start else None,
                        "startEventId": event["eventId"] if start else None,
                        "secondsSinceRecordedStart": round((horizon - start).total_seconds(), 3)
                        if start and start <= horizon
                        else None,
                        "unclosedPreviousStart": bool(event and event.get("unclosedPreviousStart")),
                    }
                )
            stages.append(
                {
                    "stage": stage,
                    "scope": entry["scope"],
                    "expectedCount": total,
                    "recordedCount": len(rows),
                    "statusCounts": _counts(rows),
                    "unrecordedCount": max(0, total - len(rows)) if total is not None else None,
                    "running": running,
                    "duration": self._duration(samples.get((run["recipe"], stage, entry["scope"]), [])),
                }
            )
        caveats.extend(
            [
                "Unrecorded tasks are declared plan members without checkpoints, not independently observed queued work.",
                "Recorded running checkpoints are business state, not a worker-slot occupancy measurement.",
            ]
        )
        return {
            key: run.get(key)
            for key in (
                "runId",
                "recipe",
                "status",
                "parentRunId",
                "scope",
                "cohortFrozen",
                "jobIds",
                "jobConcurrency",
                "createdAt",
                "updatedAt",
            )
        } | {
            "actionRun": action,
            "stages": stages,
            "eta": self._eta(run, stages, action, latest, horizon),
            "caveats": caveats,
        }

    def snapshot(self, run_id=None):
        started = _now()
        queue = _read(self.actions.run_summary)
        queue["observedAt"] = _iso(_now())
        readiness = _read(self.actions.worker_status)
        settings = _read(self.settings.snapshot)
        worker_time = _now()
        heartbeat = _time(readiness.get("heartbeatAt"))
        worker = {
            "available": readiness["available"],
            "observedAt": _iso(worker_time),
            "readiness": readiness.get("status"),
            "healthy": readiness.get("healthy"),
            "workerId": readiness.get("workerId"),
            "heartbeatAt": readiness.get("heartbeatAt"),
            "heartbeatAgeSeconds": round((worker_time - heartbeat).total_seconds(), 3) if heartbeat else None,
            "configuredActivitySlots": settings.get("workerActivitySlots") if settings["available"] else None,
            "activeActivitySlots": None,
            "availableActivitySlots": None,
            "caveats": [
                "Configured slots apply to worker starts and may differ from an already running worker.",
                "Heartbeat readiness does not measure actual worker activity-slot occupancy.",
            ],
        }
        if not settings["available"]:
            worker["caveats"].append("The configured worker capacity could not be read.")
        lanes = _read(self.model.lane_status)
        if lanes["available"]:
            lanes["lanes"] = [
                {
                    **row,
                    "availableCapacity": max(0, row["capacity"] - row["active"]) if row["unresolved"] == 0 else None,
                }
                for row in lanes["lanes"]
            ]
        lanes["caveats"] = [
            "Capacity is configured admission capacity; provider readiness and spend admission are separate.",
            "Unresolved call receipts make available lane capacity unknown.",
            "Monetary serialization can block admission despite free configured lane capacity.",
        ]
        progress = getattr(self.discovery, "progress_summary", None)
        discovery = (
            _read(progress, limit=DISCOVERY_RUN_LIMIT)
            if callable(progress)
            else {"available": False, "errorCode": "feature_progress_unavailable"}
        )
        if discovery["available"]:
            discovery["historyLimit"] = DISCOVERY_RUN_LIMIT
            discovery["historyComplete"] = len(discovery["runs"]) < DISCOVERY_RUN_LIMIT
            for run in discovery["runs"]:
                families = defaultdict(list)
                for unit in run["units"]:
                    families[unit["sourceFamily"]].append(unit)
                run["families"] = [
                    {
                        "sourceFamily": name,
                        "knownUnitCount": len(units),
                        "statusCounts": dict(Counter(unit["status"] for unit in units)),
                        "totalCompleteness": run["totalCompleteness"],
                    }
                    for name, units in sorted(families.items())
                ]
                run["recordedSourceCount"] = len(run["sources"])
                run["sourceStatusCounts"] = dict(Counter(row["status"] for row in run["sources"]))
                del run["units"], run["sources"]
            discovery["caveats"].append(
                "Only the bounded most recent Discovery runs are included; this is not a complete workspace backlog."
            )
        history = {
            "available": False,
            "since": _iso(started - timedelta(days=HISTORY_DAYS)),
            "until": _iso(started),
            "eventCount": 0,
            "complete": False,
            "caveats": ["Preparation is unavailable."],
        }
        cohorts = {
            "available": False,
            "historyLimit": RUN_LIMIT,
            "historyComplete": False,
            "selectedRunId": None,
            "runs": [],
            "caveats": ["Preparation is unavailable."],
        }
        if self.preparation is not None:
            public = _read(self.preparation.telemetry_runs, RUN_LIMIT)
            if public["available"]:
                runs = public["runs"]
                if run_id and not any(row["runId"] == run_id for row in runs):
                    runs = [self.preparation.telemetry_run(run_id), *runs]
                selected = run_id or next(
                    (row["runId"] for row in runs if row["status"] == "running"), runs[0]["runId"] if runs else None
                )
                horizon = _now()
                samples, latest, history = self._history(runs, horizon)
                display = sorted(runs, key=lambda row: row["runId"] != selected)[:DISPLAY_LIMIT]
                cohorts = {
                    "available": True,
                    "historyLimit": RUN_LIMIT,
                    "historyComplete": len(public["runs"]) < RUN_LIMIT,
                    "displayLimit": DISPLAY_LIMIT,
                    "displayComplete": len(runs) <= DISPLAY_LIMIT,
                    "selectedRunId": selected,
                    "runs": [self._cohort(run, samples, latest, horizon) for run in display],
                    "caveats": [
                        "Cohorts are the bounded recent public Preparation history; this is not a workspace-wide eligible-job backlog.",
                        "Pending sweep size outside frozen cohorts is unavailable until its owner records selection.",
                    ],
                }
            else:
                cohorts["caveats"] = ["The public Preparation history could not be read."]
        return {
            "ok": True,
            "observedAt": _iso(_now()),
            "cohorts": cohorts,
            "queue": queue,
            "worker": worker,
            "modelLanes": lanes,
            "discovery": discovery,
            "history": history,
            "caveats": [
                "Sources are independent public snapshots and can advance during collection.",
                "No business stage or outcome is inferred from heartbeat details or prose.",
            ],
        }


def build_telemetry_routes(application) -> tuple[Route, ...]:
    service = PipelineTelemetry(
        actions=application,
        events=application.runtime.events,
        model=application.runtime.model,
        settings=application.runtime.settings,
        preparation=application.services.get("preparation"),
        discovery=application.services.get("discovery"),
    )

    async def read(request):
        run_id = request.query_params.get("runId")
        if run_id is not None and (not run_id or len(run_id) > 240):
            raise AppError("invalid_telemetry_run", "Choose a saved Preparation run.")
        return JSONResponse(await run_in_threadpool(service.snapshot, run_id))

    return (Route("/v1/telemetry/pipeline", read, methods=["GET"]),)
