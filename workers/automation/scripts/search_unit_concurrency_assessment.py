#!/usr/bin/env python3
"""Reproducible synthetic assessment of JobCtrl's durable search-unit path.

The benchmark uses registered synthetic JobStreaming adapters, an owned
temporary SQLite database for every sample, the production ``run_discovery``
durable consumer, and a real ``HostRateLimiter``. Outbound sockets are blocked.
It measures current behavior; it does not add or simulate a durable worker pool.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import socket
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = 1
FIXED_QUERIES = (
    "Director of Engineering",
    "VP Engineering",
    "Platform Engineering Manager",
)
FIXED_SOURCES = ("indeed", "linkedin")
FIXED_LOCATION = "Remote"


def _percentile(values: list[float], percentile: float) -> float:
    """Return a nearest-rank percentile without a statistics dependency."""

    if not values:
        raise ValueError("percentile requires at least one value")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def _timing_summary(values: list[float]) -> dict[str, float | int]:
    if not values:
        return {"count": 0, "p50_seconds": 0.0, "p95_seconds": 0.0}
    return {
        "count": len(values),
        "p50_seconds": round(_percentile(values, 0.50), 6),
        "p95_seconds": round(_percentile(values, 0.95), 6),
        "min_seconds": round(min(values), 6),
        "max_seconds": round(max(values), 6),
    }


def _git_output(repo_root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _portable_path(path: Path | str, repo_root: Path) -> str:
    """Keep public artifacts free of workstation-specific absolute paths."""

    candidate = Path(path)
    resolved = candidate if candidate.is_absolute() else repo_root / candidate
    try:
        return resolved.relative_to(repo_root).as_posix()
    except ValueError:
        return f"<external>/{resolved.name}"


def _portable_argv(argv: list[str], repo_root: Path) -> list[str]:
    return [
        _portable_path(value, repo_root) if Path(value).is_absolute() else value
        for value in argv
    ]


@contextlib.contextmanager
def _block_outbound_network() -> Iterator[None]:
    """Reject every socket connection while synthetic adapters execute."""

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_create_connection = socket.create_connection

    def blocked_connect(_sock: socket.socket, address: object) -> None:
        raise RuntimeError(f"outbound network disabled for synthetic assessment: {address!r}")

    def blocked_connect_ex(_sock: socket.socket, address: object) -> int:
        raise RuntimeError(f"outbound network disabled for synthetic assessment: {address!r}")

    def blocked_create_connection(*_args: object, **_kwargs: object) -> socket.socket:
        raise RuntimeError("outbound network disabled for synthetic assessment")

    socket.socket.connect = blocked_connect  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked_connect_ex  # type: ignore[method-assign]
    socket.create_connection = blocked_create_connection
    try:
        yield
    finally:
        socket.socket.connect = original_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = original_connect_ex  # type: ignore[method-assign]
        socket.create_connection = original_create_connection


@dataclass
class _Recorder:
    run_started: float = 0.0
    adapter_starts: list[float] = field(default_factory=list)
    adapter_durations: list[float] = field(default_factory=list)
    limiter_waits: list[float] = field(default_factory=list)
    persistence_durations: list[float] = field(default_factory=list)
    checkpoint_save_durations: list[float] = field(default_factory=list)
    first_accepted_at: float | None = None
    adapter_calls: int = 0
    active_adapters: int = 0
    max_active_adapters: int = 0
    adapter_started: threading.Event = field(default_factory=threading.Event)
    limiter_entered: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def adapter_begin(self) -> float:
        started = time.perf_counter()
        with self.lock:
            self.adapter_calls += 1
            self.active_adapters += 1
            self.max_active_adapters = max(self.max_active_adapters, self.active_adapters)
            self.adapter_starts.append(started)
            self.adapter_started.set()
        return started

    def adapter_end(self, started: float) -> None:
        ended = time.perf_counter()
        with self.lock:
            self.active_adapters -= 1
            self.adapter_durations.append(ended - started)


class _ObservedLimiter:
    """Timing wrapper around the production ``HostRateLimiter`` instance."""

    def __init__(self, delegate: object, recorder: _Recorder) -> None:
        self.delegate = delegate
        self.recorder = recorder

    @contextlib.contextmanager
    def slot(
        self,
        host: str,
        *,
        min_interval_seconds: float,
        max_concurrency: int,
    ) -> Iterator[None]:
        entered = time.perf_counter()
        self.recorder.limiter_entered.set()
        with self.delegate.slot(  # type: ignore[attr-defined]
            host,
            min_interval_seconds=min_interval_seconds,
            max_concurrency=max_concurrency,
        ):
            acquired = time.perf_counter()
            with self.recorder.lock:
                self.recorder.limiter_waits.append(acquired - entered)
            yield


def _config(queries: tuple[str, ...], sources: tuple[str, ...]) -> dict[str, Any]:
    return {
        "boards": list(sources),
        "queries": [{"query": query} for query in queries],
        "locations": [{"label": "remote", "location": FIXED_LOCATION, "remote": True}],
        "defaults": {
            "results_per_site": 1,
            "hours_old": 72,
            "country_indeed": "usa",
        },
        "location": {
            "accept_patterns": [FIXED_LOCATION],
            "reject_patterns": [],
            "local_accept_patterns": [FIXED_LOCATION],
        },
        "max_parallel_families": 1,
    }


def _synthetic_registry(
    recorder: _Recorder,
    *,
    service_delay_seconds: float,
    fail_first_call: bool = False,
) -> object:
    from jobstreaming import (
        AdapterCapabilities,
        AdapterRegistry,
        JobPost,
        JobResponse,
        Location,
        Scraper,
        Site,
        TransientNetworkError,
    )

    registry = AdapterRegistry()

    def register(site: Site) -> None:
        class SyntheticAdapter(Scraper):
            capabilities = AdapterCapabilities(
                filters=frozenset({"location", "is_remote", "hours_old"})
            )

            def __init__(self, **_: object) -> None:
                super().__init__(site)

            def scrape(self, request: object, context: object | None = None) -> JobResponse:
                if context is None:
                    raise AssertionError("synthetic adapter requires a JobStreaming context")
                started = recorder.adapter_begin()
                try:
                    with recorder.lock:
                        call_number = recorder.adapter_calls
                    if fail_first_call and call_number == 1:
                        raise TransientNetworkError("synthetic transient provider failure")
                    if service_delay_seconds > 0:
                        context.wait(service_delay_seconds)  # type: ignore[attr-defined]
                    query = str(request.search_term)  # type: ignore[attr-defined]
                    slug = "-".join(query.casefold().split())
                    context.emit_job(  # type: ignore[attr-defined]
                        JobPost(
                            id=f"{site.value}-{slug}",
                            title=query,
                            company_name=f"Synthetic {site.value}",
                            job_url=f"https://synthetic.invalid/{site.value}/{slug}",
                            location=Location(city=FIXED_LOCATION),
                            description=(
                                "Synthetic role evidence for a fixed, offline benchmark cohort. "
                                * 6
                            ),
                            is_remote=True,
                        ),
                        {"offset": 1},
                    )
                    return JobResponse()
                finally:
                    recorder.adapter_end(started)

        registry.register(site, SyntheticAdapter)

    for source in FIXED_SOURCES:
        register(Site(source))
    return registry


@contextlib.contextmanager
def _patched_durable_path(
    *,
    db_path: Path,
    recorder: _Recorder,
    limiter: object,
) -> Iterator[object]:
    from jobctrl import database
    from jobctrl.discovery import jobspy
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
        SqliteDiscoverySearchUnitCheckpointStore,
    )

    original_init_db = jobspy.init_db
    original_get_connection = jobspy.get_connection
    original_get_limiter = jobspy.get_shared_rate_limiter
    original_store = jobspy.store_jobspy_results
    original_checkpoint_save = SqliteDiscoverySearchUnitCheckpointStore.save

    def owned_init_db() -> object:
        return database.init_db(db_path)

    def owned_get_connection() -> object:
        return database.get_connection(db_path)

    def timed_store(*args: object, **kwargs: object) -> tuple[int, int]:
        started = time.perf_counter()
        result = original_store(*args, **kwargs)
        ended = time.perf_counter()
        with recorder.lock:
            recorder.persistence_durations.append(ended - started)
            if recorder.first_accepted_at is None and sum(result) > 0:
                recorder.first_accepted_at = ended
        return result

    def timed_checkpoint_save(self: object, checkpoint: object) -> None:
        started = time.perf_counter()
        try:
            original_checkpoint_save(self, checkpoint)
        finally:
            with recorder.lock:
                recorder.checkpoint_save_durations.append(time.perf_counter() - started)

    jobspy.init_db = owned_init_db
    jobspy.get_connection = owned_get_connection
    jobspy.get_shared_rate_limiter = lambda: _ObservedLimiter(limiter, recorder)
    jobspy.store_jobspy_results = timed_store
    SqliteDiscoverySearchUnitCheckpointStore.save = timed_checkpoint_save
    try:
        yield jobspy
    finally:
        jobspy.init_db = original_init_db
        jobspy.get_connection = original_get_connection
        jobspy.get_shared_rate_limiter = original_get_limiter
        jobspy.store_jobspy_results = original_store
        SqliteDiscoverySearchUnitCheckpointStore.save = original_checkpoint_save


def _db_evidence(db_path: Path, execution: object) -> dict[str, Any]:
    from jobctrl import database
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
        SqliteDiscoverySearchUnitRepository,
    )

    conn = database.init_db(db_path)
    repository = SqliteDiscoverySearchUnitRepository(conn)
    units = repository.list_units(execution)
    evidence = {
        "unit_states": [unit.state for unit in units],
        "unit_count": len(units),
        "receipt_counts": repository.execution_counts(execution),
        "job_rows": int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]),
        "receipt_rows": int(
            conn.execute("SELECT COUNT(*) FROM discovery_search_unit_jobs").fetchone()[0]
        ),
        "checkpointed_units": int(
            conn.execute(
                "SELECT COUNT(*) FROM discovery_search_units WHERE checkpoint_revision IS NOT NULL"
            ).fetchone()[0]
        ),
        "checkpoint_revisions": [unit.checkpoint_revision for unit in units],
        "job_event_rows": int(conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]),
        "recovery_count": sum(unit.recovery_count for unit in units),
    }
    database.close_connection(db_path)
    return evidence


def _sample_payload(
    recorder: _Recorder,
    *,
    wall_seconds: float,
    result: dict[str, Any] | None,
    db_evidence: dict[str, Any],
    expected_units: int,
) -> dict[str, Any]:
    starts = sorted(recorder.adapter_starts)
    gaps = [later - earlier for earlier, later in zip(starts, starts[1:])]
    first_accepted = (
        recorder.first_accepted_at - recorder.run_started
        if recorder.first_accepted_at is not None
        else None
    )
    complete = db_evidence["unit_states"] == ["completed"] * expected_units
    return {
        "wall_seconds": round(wall_seconds, 6),
        "time_to_first_accepted_seconds": (
            round(first_accepted, 6) if first_accepted is not None else None
        ),
        "provider_service_seconds": [round(value, 6) for value in recorder.adapter_durations],
        "limiter_wait_seconds": [round(value, 6) for value in recorder.limiter_waits],
        "persistence_seconds": [round(value, 6) for value in recorder.persistence_durations],
        "checkpoint_save_seconds": [
            round(value, 6) for value in recorder.checkpoint_save_durations
        ],
        "adapter_start_offsets_seconds": [
            round(value - recorder.run_started, 6) for value in starts
        ],
        "adapter_start_gaps_seconds": [round(value, 6) for value in gaps],
        "adapter_calls": recorder.adapter_calls,
        "max_active_adapters": recorder.max_active_adapters,
        "result": result,
        "database": db_evidence,
        "invariants": {
            "all_units_completed": complete,
            "exact_unit_count": db_evidence["unit_count"] == expected_units,
            "exact_job_count": db_evidence["job_rows"] == expected_units,
            "exact_receipt_count": db_evidence["receipt_rows"] == expected_units,
            "all_units_checkpointed": db_evidence["checkpointed_units"] == expected_units,
            "host_spacing_preserved": all(value >= 0.98 for value in gaps),
            "provider_concurrency_at_most_policy": recorder.max_active_adapters <= 1,
        },
    }


def _run_production_sample(
    workspace: Path,
    *,
    sample_id: str,
    queries: tuple[str, ...],
    sources: tuple[str, ...],
    service_delay_seconds: float,
    fail_first_call: bool = False,
) -> dict[str, Any]:
    from jobctrl import database
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    db_path = workspace / f"{sample_id}.db"
    recorder = _Recorder()
    limiter = HostRateLimiter()
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id=f"assessment-{sample_id}",
        temporal_run_id=f"assessment-run-{sample_id}",
    )
    registry = _synthetic_registry(
        recorder,
        service_delay_seconds=service_delay_seconds,
        fail_first_call=fail_first_call,
    )
    expected_units = len(queries) * len(sources)
    try:
        with _patched_durable_path(db_path=db_path, recorder=recorder, limiter=limiter) as jobspy:
            recorder.run_started = time.perf_counter()
            result = jobspy.run_discovery(
                cfg=_config(queries, sources),
                run_id=sample_id,
                discovery_execution=execution,
                activity_attempt=1,
                activity_owner_token=f"{sample_id}-owner",
                adapter_registry=registry,
            )
            wall_seconds = time.perf_counter() - recorder.run_started
        evidence = _db_evidence(db_path, execution)
        return _sample_payload(
            recorder,
            wall_seconds=wall_seconds,
            result=result,
            db_evidence=evidence,
            expected_units=expected_units,
        )
    finally:
        database.close_connection(db_path)
        for suffix in ("", "-wal", "-shm"):
            Path(f"{db_path}{suffix}").unlink(missing_ok=True)


def _run_cancellation_scenario(
    workspace: Path,
    *,
    scenario: str,
) -> dict[str, Any]:
    from jobctrl import database
    from jobctrl.discovery.jobspy import DiscoveryCancelled
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
    from jobctrl.domain.discovery.source_registry import BROAD_BOARD_LEAD_POLICY
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    db_path = workspace / f"cancellation-{scenario}.db"
    recorder = _Recorder()
    limiter = HostRateLimiter()
    cancel_event = threading.Event()
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id=f"assessment-cancel-{scenario}",
        temporal_run_id=f"assessment-cancel-run-{scenario}",
    )
    registry = _synthetic_registry(
        recorder,
        service_delay_seconds=5.0 if scenario == "active_provider_wait" else 0.0,
    )
    if scenario == "pending":
        cancel_event.set()
    if scenario == "limiter_wait":
        with limiter.slot(
            "jobspy",
            min_interval_seconds=BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
            max_concurrency=BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host,
        ):
            pass

    cancel_latency: float | None = None
    outcome = "unexpected_completion"
    try:
        with _patched_durable_path(db_path=db_path, recorder=recorder, limiter=limiter) as jobspy:
            recorder.run_started = time.perf_counter()

            def run() -> dict[str, Any]:
                return jobspy.run_discovery(
                    cfg=_config(FIXED_QUERIES, FIXED_SOURCES),
                    run_id=f"cancel-{scenario}",
                    cancel_event=cancel_event,
                    discovery_execution=execution,
                    activity_attempt=1,
                    activity_owner_token=f"cancel-{scenario}-owner",
                    adapter_registry=registry,
                )

            if scenario == "pending":
                try:
                    run()
                except DiscoveryCancelled:
                    outcome = "canceled"
                    cancel_latency = time.perf_counter() - recorder.run_started
            else:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(run)
                    ready = (
                        recorder.adapter_started
                        if scenario == "active_provider_wait"
                        else recorder.limiter_entered
                    )
                    if not ready.wait(timeout=5):
                        raise RuntimeError(f"{scenario} did not reach its measured wait")
                    if scenario == "limiter_wait":
                        time.sleep(0.05)
                    canceled_at = time.perf_counter()
                    cancel_event.set()
                    try:
                        future.result(timeout=10)
                    except DiscoveryCancelled:
                        outcome = "canceled"
                        cancel_latency = time.perf_counter() - canceled_at
            wall_seconds = time.perf_counter() - recorder.run_started
        evidence = _db_evidence(db_path, execution)
        return {
            "scenario": scenario,
            "outcome": outcome,
            "wall_seconds": round(wall_seconds, 6),
            "cancel_to_return_seconds": (
                round(cancel_latency, 6) if cancel_latency is not None else None
            ),
            "adapter_calls": recorder.adapter_calls,
            "limiter_wait_seconds": [round(value, 6) for value in recorder.limiter_waits],
            "unit_states": evidence["unit_states"],
            "all_unfinished_terminalized": all(
                state in {"canceled", "completed", "failed", "skipped"}
                for state in evidence["unit_states"]
            ),
        }
    finally:
        database.close_connection(db_path)
        for suffix in ("", "-wal", "-shm"):
            Path(f"{db_path}{suffix}").unlink(missing_ok=True)


def _run_limiter_only_diagnostic(
    *,
    service_delay_seconds: float,
    unit_count: int,
) -> dict[str, Any]:
    from jobctrl.domain.discovery.source_registry import BROAD_BOARD_LEAD_POLICY
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    limiter = HostRateLimiter()
    start_gate = threading.Event()
    lock = threading.Lock()
    starts: list[float] = []
    waits: list[float] = []
    active = 0
    max_active = 0
    wall_started = time.perf_counter()

    def compete(_index: int) -> None:
        nonlocal active, max_active
        start_gate.wait()
        entered = time.perf_counter()
        with limiter.slot(
            "jobspy",
            min_interval_seconds=BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
            max_concurrency=BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host,
        ):
            started = time.perf_counter()
            with lock:
                waits.append(started - entered)
                starts.append(started)
                active += 1
                max_active = max(max_active, active)
            time.sleep(service_delay_seconds)
            with lock:
                active -= 1

    with ThreadPoolExecutor(max_workers=unit_count) as executor:
        futures = [executor.submit(compete, index) for index in range(unit_count)]
        start_gate.set()
        for future in futures:
            future.result(timeout=max(10.0, unit_count * 2.0))
    wall_seconds = time.perf_counter() - wall_started
    ordered = sorted(starts)
    gaps = [later - earlier for earlier, later in zip(ordered, ordered[1:])]
    return {
        "label": "diagnostic_limiter_only_not_durable_production",
        "durable_path": False,
        "wall_seconds": round(wall_seconds, 6),
        "call_start_offsets_seconds": [round(value - wall_started, 6) for value in ordered],
        "call_start_gaps_seconds": [round(value, 6) for value in gaps],
        "limiter_wait_seconds": [round(value, 6) for value in waits],
        "max_active_calls": max_active,
        "invariants": {
            "host_spacing_preserved": all(value >= 0.98 for value in gaps),
            "concurrency_at_most_policy": max_active <= 1,
        },
    }


def _arm_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    first_accepted = [
        float(sample["time_to_first_accepted_seconds"])
        for sample in samples
        if sample["time_to_first_accepted_seconds"] is not None
    ]
    return {
        "wall": _timing_summary([float(sample["wall_seconds"]) for sample in samples]),
        "time_to_first_accepted": _timing_summary(first_accepted),
        "provider_service": _timing_summary(
            [value for sample in samples for value in sample["provider_service_seconds"]]
        ),
        "limiter_wait": _timing_summary(
            [value for sample in samples for value in sample["limiter_wait_seconds"]]
        ),
        "persistence": _timing_summary(
            [value for sample in samples for value in sample["persistence_seconds"]]
        ),
        "checkpoint_save": _timing_summary(
            [value for sample in samples for value in sample["checkpoint_save_seconds"]]
        ),
        "all_invariants_met": all(
            all(sample["invariants"].values()) for sample in samples
        ),
    }


def _provenance(repo_root: Path) -> dict[str, Any]:
    lock_path = repo_root / "workers" / "automation" / "uv.lock"
    return {
        "git_head": _git_output(repo_root, "rev-parse", "HEAD"),
        "git_branch": _git_output(repo_root, "branch", "--show-current"),
        "git_status_porcelain": _git_output(repo_root, "status", "--porcelain").splitlines(),
        "python": sys.version,
        "python_executable": _portable_path(sys.executable, repo_root),
        "jobstreaming_version": importlib.metadata.version("jobstreaming"),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "uv_lock_sha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(),
    }


def run_assessment(
    *,
    output: Path,
    warmups: int,
    repeats: int,
    service_delay_seconds: float,
    smoke: bool,
) -> dict[str, Any]:
    from jobctrl.domain.discovery.source_registry import BROAD_BOARD_LEAD_POLICY
    from jobctrl.infrastructure.temporal.concurrency import (
        DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES,
    )

    repo_root = Path(__file__).resolve().parents[3]
    portable_output = _portable_path(output, repo_root)
    queries = FIXED_QUERIES if not smoke else FIXED_QUERIES[:1]
    sources = FIXED_SOURCES if not smoke else FIXED_SOURCES[:1]
    warmups = 0 if smoke else warmups
    service_delay_seconds = 0.0 if smoke else service_delay_seconds
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="jobctrl-search-unit-assessment-",
        dir=output.parent,
    ) as workspace_text:
        workspace = Path(workspace_text)
        for index in range(warmups):
            _run_production_sample(
                workspace,
                sample_id=f"warmup-baseline-{index}",
                queries=queries,
                sources=sources,
                service_delay_seconds=service_delay_seconds,
            )
            _run_production_sample(
                workspace,
                sample_id=f"warmup-zero-service-{index}",
                queries=queries,
                sources=sources,
                service_delay_seconds=0.0,
            )

        baseline = [
            _run_production_sample(
                workspace,
                sample_id=f"baseline-{index}",
                queries=queries,
                sources=sources,
                service_delay_seconds=service_delay_seconds,
            )
            for index in range(repeats)
        ]
        zero_service = [
            _run_production_sample(
                workspace,
                sample_id=f"zero-service-{index}",
                queries=queries,
                sources=sources,
                service_delay_seconds=0.0,
            )
            for index in range(repeats)
        ]

        diagnostics: dict[str, Any] = {}
        scenarios: dict[str, Any] = {}
        if not smoke:
            diagnostics["competing_calls"] = _run_limiter_only_diagnostic(
                service_delay_seconds=service_delay_seconds,
                unit_count=len(queries) * len(sources),
            )
            for scenario in ("pending", "active_provider_wait", "limiter_wait"):
                scenarios[scenario] = _run_cancellation_scenario(
                    workspace,
                    scenario=scenario,
                )
            retry = _run_production_sample(
                workspace,
                sample_id="provider-retry",
                queries=queries[:1],
                sources=sources[:1],
                service_delay_seconds=service_delay_seconds,
                fail_first_call=True,
            )
            retry["retry_completed"] = (
                retry["adapter_calls"] == 2
                and retry["database"]["unit_states"] == ["completed"]
            )
            scenarios["provider_retry"] = retry

    artifact = {
        "schema_version": SCHEMA_VERSION,
        "work_id": "jobctrl-899-search-unit-assessment",
        "mode": "smoke" if smoke else "assessment",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": {
            "durable_path": "jobctrl.discovery.jobspy.run_discovery",
            "gateway": "JobStreamingGateway.open_stream",
            "persistence": "SQLite search units, receipts, jobs, and checkpoints",
            "network": "all socket connect operations blocked",
            "data": "owned temporary synthetic workspaces only",
        },
        "cohort": {
            "queries": list(queries),
            "sources": list(sources),
            "location": FIXED_LOCATION,
            "search_units": len(queries) * len(sources),
            "results_per_source_unit": 1,
            "synthetic_service_delay_seconds": service_delay_seconds,
            "warmups": warmups,
            "measured_repeats": repeats,
        },
        "current_policy": {
            "min_request_interval_seconds": BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
            "max_concurrent_requests_per_host": (
                BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host
            ),
            "max_search_unit_invocations_per_run": (
                BROAD_BOARD_LEAD_POLICY.max_requests_per_run
            ),
            "default_max_parallel_source_families": (
                DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES
            ),
            "default_worker_activity_slots": DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        },
        "arms": {
            "current_policy_baseline": {
                "durable_path": True,
                "service_delay_seconds": service_delay_seconds,
                "samples": baseline,
                "summary": _arm_summary(baseline),
            },
            "zero_service_latency_control": {
                "durable_path": True,
                "policy_unchanged": True,
                "service_delay_seconds": 0.0,
                "samples": zero_service,
                "summary": _arm_summary(zero_service),
            },
        },
        "diagnostics": diagnostics,
        "scenarios": scenarios,
        "measurement_caveats": [
            "Synthetic service delays do not estimate real-provider throughput or safe provider policy.",
            "Persistence timing wraps store_jobspy_results and therefore includes its SQLite acceptance and receipt work.",
            "Checkpoint-save timing observes synchronous checkpoint persistence called by acknowledgements; it is not the entire stream.ack call.",
            "Provider, limiter, persistence, and checkpoint timings can overlap in wall-clock accounting and must not be summed as a decomposition.",
            "The competing-call arm exercises only the real limiter and is diagnostic, not concurrent durable production.",
        ],
        "provenance": _provenance(repo_root),
        "reproduce": {
            "locked_command": (
                "env -u UV_PROJECT_ENVIRONMENT -u VIRTUAL_ENV -u UV_EXCLUDE_NEWER "
                "-u UV_EXCLUDE_NEWER_PACKAGE uv run --project workers/automation "
                "--locked --all-extras --exclude-newer false python "
                "workers/automation/scripts/search_unit_concurrency_assessment.py "
                f"--output {portable_output} --warmups {warmups} --repeats {repeats} "
                f"--service-delay-seconds {service_delay_seconds}"
            ),
            "observed_argv": _portable_argv([sys.executable, *sys.argv], repo_root),
        },
    }
    output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return artifact


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--service-delay-seconds", type=float, default=0.05)
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="run a one-unit harness smoke; output is labeled smoke and is not assessment evidence",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.warmups < 0:
        raise SystemExit("--warmups must be non-negative")
    if args.repeats < 1:
        raise SystemExit("--repeats must be positive")
    if args.service_delay_seconds < 0:
        raise SystemExit("--service-delay-seconds must be non-negative")

    # Set the JobCtrl state root before importing any JobCtrl module. Samples
    # still inject per-sample DB paths so every repeat starts from identical state.
    with tempfile.TemporaryDirectory(prefix="jobctrl-search-unit-config-") as config_dir:
        os.environ["JOBCTRL_DIR"] = config_dir
        os.environ["LANGFUSE_DISABLE"] = "1"
        with _block_outbound_network():
            artifact = run_assessment(
                output=args.output.resolve(),
                warmups=args.warmups,
                repeats=args.repeats,
                service_delay_seconds=args.service_delay_seconds,
                smoke=args.smoke,
            )
    print(json.dumps({"mode": artifact["mode"], "output": str(args.output.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
