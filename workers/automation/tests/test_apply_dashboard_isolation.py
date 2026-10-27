"""Per-run dashboard reads and resets preserve concurrent owners' private state."""

from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from threading import Barrier

import pytest
from rich.console import Console

from jobctrl.apply import dashboard

ALPHA = (10101, 10102)
BETA = (20201, 20202)


@pytest.fixture(autouse=True)
def isolated_dashboard():
    dashboard.reset_dashboard()
    yield
    dashboard.reset_dashboard()


@pytest.fixture
def cohorts():
    barrier = Barrier(2)

    def seed(owner, name, applied, failed, costs):
        barrier.wait(timeout=5)
        for display_id, worker_id in enumerate(owner):
            dashboard.init_worker(worker_id, display_id=display_id)
            dashboard.update_state(
                worker_id,
                job_title=f"{name} private job {display_id}",
                company=f"{name} employer",
                last_action=f"{name} private action",
                jobs_applied=applied[display_id],
                jobs_failed=failed[display_id],
                total_cost=costs[display_id],
            )
            dashboard.add_event(f"{name} private event {display_id}", worker_id=worker_id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        alpha = pool.submit(seed, ALPHA, "Alpha", (1, 2), (0, 1), (0.1, 0.2))
        beta = pool.submit(seed, BETA, "Beta", (10, 11), (2, 3), (1.25, 2.5))
        alpha.result(timeout=10)
        beta.result(timeout=10)
    dashboard.add_event("legacy private event")


def rendered(owner):
    output = StringIO()
    Console(file=output, width=180, color_system=None).print(dashboard.render_full(owner))
    return output.getvalue()


def test_totals_and_updates_are_scoped(cohorts):
    beta_states = dashboard.get_worker_states(BETA)
    beta_events = dashboard.get_recent_events(BETA)
    assert dashboard.get_totals(ALPHA) == {"applied": 3, "failed": 1, "cost": pytest.approx(0.3)}
    assert dashboard.get_totals(BETA) == {"applied": 21, "failed": 5, "cost": 3.75}
    for worker_id in ALPHA:
        dashboard.update_state(worker_id, status="done")
    assert dashboard.get_worker_states(BETA) == beta_states
    assert dashboard.get_recent_events(BETA) == beta_events
    assert [s.worker_id for s in dashboard.get_worker_states(ALPHA)] == [0, 1]
    assert [s.worker_id for s in beta_states] == [0, 1]
    beta_states[0].jobs_applied = 999
    assert dashboard.get_totals(BETA)["applied"] == 21


def test_reset_only_selected_resource_ids(cohorts):
    beta_states = dashboard.get_worker_states(BETA)
    beta_events = dashboard.get_recent_events(BETA)
    dashboard.reset_dashboard(iter(ALPHA))
    assert dashboard.get_worker_states(ALPHA) == []
    assert dashboard.get_recent_events(ALPHA) == []
    assert dashboard.get_worker_states(BETA) == beta_states
    assert dashboard.get_recent_events(BETA) == beta_events
    assert dashboard.get_totals(BETA) == {"applied": 21, "failed": 5, "cost": 3.75}


@pytest.mark.parametrize("owner,name,peer,cost", [(ALPHA, "Alpha", "Beta", "$0.300"), (BETA, "Beta", "Alpha", "$3.750")])
def test_render_freezes_generator_and_excludes_other_owners(cohorts, owner, name, peer, cost):
    output = rendered(iter(owner))
    assert f"{name} private job 0" in output
    assert f"{name} private job 1" in output
    assert f"{name} private event 0" in output
    assert f"{name} private event 1" in output
    assert peer not in output
    assert "legacy private event" not in output
    assert cost in output
    for worker_id in (*ALPHA, *BETA):
        assert str(worker_id) not in output
    table = dashboard.render_dashboard(owner)
    assert table.columns[0]._cells[:2] == ["0", "1"]


def test_event_flood_does_not_evict_other_owner_history(cohorts):
    beta_events = dashboard.get_recent_events(BETA)
    for sequence in range(3 * dashboard.MAX_EVENTS):
        dashboard.add_event(f"Alpha flood {sequence:02d}", worker_id=ALPHA[sequence % 2])
    expected = [f"Alpha flood {n:02d}" for n in range(2 * dashboard.MAX_EVENTS, 3 * dashboard.MAX_EVENTS)]
    assert [event.split("[/dim] ", 1)[1] for event in dashboard.get_recent_events(ALPHA)] == expected
    assert dashboard.get_recent_events(BETA) == beta_events
    assert dashboard.get_recent_events(None) == dashboard.get_recent_events(ALPHA)
    dashboard.reset_dashboard(ALPHA)
    assert dashboard.get_recent_events(BETA) == beta_events


def test_empty_selector_reads_and_resets_nothing(cohorts):
    states = dashboard.get_worker_states()
    events = dashboard.get_recent_events()
    totals = dashboard.get_totals()
    assert dashboard.get_worker_states(()) == []
    assert dashboard.get_recent_events(iter(())) == []
    assert dashboard.get_totals(()) == {"applied": 0, "failed": 0, "cost": 0}
    output = rendered(iter(()))
    assert "Alpha" not in output and "Beta" not in output and "legacy" not in output
    dashboard.reset_dashboard(())
    assert dashboard.get_worker_states() == states
    assert dashboard.get_recent_events() == events
    assert dashboard.get_totals() == totals


def test_none_explicitly_selects_all_owners(cohorts):
    assert len(dashboard.get_worker_states(None)) == 4
    events = dashboard.get_recent_events(None)
    assert len(events) == 5
    assert any("legacy private event" in event for event in events)
    assert dashboard.get_totals(None) == {"applied": 24, "failed": 6, "cost": 4.05}
    dashboard.reset_dashboard(None)
    assert dashboard.get_worker_states() == []
    assert dashboard.get_recent_events() == []


def test_reset_can_overlap_another_owners_update(cohorts):
    beta_second = dashboard.get_worker_states((BETA[1],))
    barrier = Barrier(2)

    def reset_alpha():
        barrier.wait(timeout=5)
        dashboard.reset_dashboard(ALPHA)

    def update_beta():
        barrier.wait(timeout=5)
        dashboard.update_state(BETA[0], status="applied", jobs_applied=42, total_cost=6.25)
        dashboard.add_event("Beta concurrent private event", worker_id=BETA[0])

    with ThreadPoolExecutor(max_workers=2) as pool:
        reset = pool.submit(reset_alpha)
        update = pool.submit(update_beta)
        reset.result(timeout=10)
        update.result(timeout=10)
    assert dashboard.get_worker_states((BETA[1],)) == beta_second
    assert dashboard.get_totals(BETA) == {"applied": 53, "failed": 5, "cost": 8.75}
    assert any("Beta concurrent private event" in event for event in dashboard.get_recent_events(BETA))
    assert "Alpha" not in rendered(BETA)
    assert dashboard.get_worker_states(ALPHA) == []
