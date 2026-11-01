"""Rich live dashboard for the apply pipeline.

Displays real-time worker status, job progress, and recent events
in a terminal dashboard using the Rich library.
"""

import copy
import itertools
import logging
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from rich.console import Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

logger = logging.getLogger(__name__)


@dataclass
class WorkerState:
    """Tracks the current state of the apply worker."""

    worker_id: int = 0
    run_id: str = ""
    status: str = "starting"  # starting, applying, applied, failed, expired, captcha, idle, done
    job_title: str = ""
    company: str = ""
    score: int = 0
    start_time: float = 0.0
    actions: int = 0
    last_action: str = ""
    jobs_applied: int = 0
    jobs_failed: int = 0
    jobs_done: int = 0
    total_cost: float = 0.0
    log_file: Path | None = None


# Module-level state (thread-safe via _lock)
_worker_states: dict[int, WorkerState] = {}
_events: dict[int | None, list[tuple[int, str]]] = {}
_event_sequence = itertools.count()
_lock = threading.Lock()
MAX_EVENTS = 8


# ---------------------------------------------------------------------------
# State mutation helpers
# ---------------------------------------------------------------------------

def reset_dashboard(worker_ids: Iterable[int] | None = None) -> None:
    """Clear selected resource owners; None explicitly clears all owners."""
    selected = None if worker_ids is None else frozenset(worker_ids)
    with _lock:
        if selected is None:
            _worker_states.clear()
            _events.clear()
        else:
            for worker_id in selected:
                _worker_states.pop(worker_id, None)
                _events.pop(worker_id, None)


def init_worker(worker_id: int = 0, *, display_id: int | None = None) -> None:
    """Register the worker in the dashboard state."""
    with _lock:
        _worker_states[worker_id] = WorkerState(worker_id=worker_id if display_id is None else display_id)


def update_state(worker_id: int = 0, **kwargs) -> None:
    """Update the worker's state fields.

    Args:
        worker_id: Which worker to update.
        **kwargs: Field names and values to set on WorkerState.
    """
    with _lock:
        state = _worker_states.get(worker_id)
        if state is not None:
            for key, value in kwargs.items():
                setattr(state, key, value)


def get_state(worker_id: int = 0) -> WorkerState | None:
    """Read the worker's current state."""
    with _lock:
        return _worker_states.get(worker_id)


def get_worker_states(worker_ids: Iterable[int] | None = None) -> list[WorkerState]:
    """Copy selected states, ordered by display ordinal and resource identity."""
    selected = None if worker_ids is None else frozenset(worker_ids)
    with _lock:
        items = (
            (worker_id, state) for worker_id, state in _worker_states.items()
            if selected is None or worker_id in selected
        )
        return [copy.copy(state) for _, state in sorted(items, key=lambda item: (item[1].worker_id, item[0]))]


def get_recent_events(worker_ids: Iterable[int] | None = None) -> list[str]:
    """Merge selected owners' event buffers in original insertion order."""
    selected = None if worker_ids is None else frozenset(worker_ids)
    with _lock:
        events = [
            event for worker_id, buffer in _events.items()
            if selected is None or worker_id in selected
            for event in buffer
        ]
        return [message for _, message in sorted(events)[-MAX_EVENTS:]]


def add_event(msg: str, *, worker_id: int | None = None) -> None:
    """Append an event to its resource owner's bounded buffer.

    Unowned legacy events are visible only to explicit all-owner readers.
    Ownership never comes from display text.
    """
    ts = datetime.now().strftime("%H:%M:%S")
    with _lock:
        buffer = _events.setdefault(worker_id, [])
        buffer.append((next(_event_sequence), f"[dim]{ts}[/dim] {msg}"))
        del buffer[:-MAX_EVENTS]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

# Status -> Rich style mapping
_STATUS_STYLES: dict[str, str] = {
    "starting": "dim",
    "idle": "dim",
    "launching": "cyan",
    "applying": "yellow",
    "running": "cyan",
    "prompting": "cyan",
    "applied": "bold green",
    "finished": "bold green",
    "failed": "red",
    "expired": "dim red",
    "captcha": "magenta",
    "login_issue": "red",
    "done": "bold",
}


def render_dashboard(worker_ids: Iterable[int] | None = None) -> Table:
    """Build the Rich table showing selected worker statuses.

    Returns:
        A Rich Table object ready for display.
    """
    table = Table(title="JobCtrl Dashboard", expand=True, show_lines=False)
    table.add_column("W", style="bold", width=3, justify="center")
    table.add_column("Run", width=10, justify="center")
    table.add_column("Job", min_width=30, max_width=50, no_wrap=True)
    table.add_column("Status", width=12, justify="center")
    table.add_column("Time", width=6, justify="right")
    table.add_column("Acts", width=5, justify="right")
    table.add_column("Last Action", min_width=20, max_width=35, no_wrap=True)
    table.add_column("OK", width=4, justify="right", style="green")
    table.add_column("Fail", width=4, justify="right", style="red")
    table.add_column("Cost", width=8, justify="right")

    states = get_worker_states(worker_ids)

    total_applied = 0
    total_failed = 0
    total_cost = 0.0

    for s in states:
        elapsed = ""
        if s.start_time and s.status == "applying":
            elapsed = f"{int(time.time() - s.start_time)}s"

        style = _STATUS_STYLES.get(s.status, "")
        status_text = Text(s.status.upper(), style=style)
        run_text = s.run_id[:8] if s.run_id else ""

        job_text = f"{s.job_title[:28]} @ {s.company[:16]}" if s.job_title else ""

        table.add_row(
            str(s.worker_id),
            run_text,
            job_text,
            status_text,
            elapsed,
            str(s.actions) if s.actions else "",
            s.last_action[:35] if s.last_action else "",
            str(s.jobs_applied),
            str(s.jobs_failed),
            f"${s.total_cost:.3f}" if s.total_cost else "",
        )
        total_applied += s.jobs_applied
        total_failed += s.jobs_failed
        total_cost += s.total_cost

    # Totals row
    table.add_section()
    table.add_row(
        "", "", "", "", "", "", "TOTAL",
        str(total_applied), str(total_failed), f"${total_cost:.3f}",
        style="bold",
    )

    return table


def render_full(worker_ids: Iterable[int] | None = None) -> Table | Group:
    """Render the dashboard table plus the recent events panel.

    Returns:
        A Rich Group (table + events panel) or just the table if no events.
    """
    selected = None if worker_ids is None else frozenset(worker_ids)
    table = render_dashboard(selected)
    event_lines = get_recent_events(selected)

    if event_lines:
        event_text = Text.from_markup("\n".join(event_lines))
        events_panel = Panel(
            event_text,
            title="Recent Events",
            border_style="dim",
            height=min(MAX_EVENTS + 2, len(event_lines) + 2),
        )
        return Group(table, events_panel)

    return table


def get_totals(worker_ids: Iterable[int] | None = None) -> dict[str, int | float]:
    """Compute aggregate totals across selected workers.

    Returns:
        Dict with keys: applied, failed, cost.
    """
    states = get_worker_states(worker_ids)
    applied = sum(s.jobs_applied for s in states)
    failed = sum(s.jobs_failed for s in states)
    cost = sum(s.total_cost for s in states)
    return {"applied": applied, "failed": failed, "cost": cost}
