"""Canonical local Apply controls, independent of lifecycle projections.

An intent is a permanent no-blind-retry boundary. Neither a failed result nor
an unrelated local stage label proves that the provider did not accept it.
"""

# Correlated selectors bind the canonical job to the fixed alias `jobs`.
APPLY_SUBMIT_INTENT_SQL = """
EXISTS (
    SELECT 1 FROM job_events intent
    WHERE intent.tenant_id = jobs.tenant_id AND intent.job_id = jobs.job_id
      AND intent.stage = 'apply' AND intent.event_type = 'ApplySubmitIntended'
)
"""
APPLY_STOPPED_SQL = """
EXISTS (
    SELECT 1 FROM job_stage_states control
    WHERE control.tenant_id = jobs.tenant_id AND control.job_id = jobs.job_id
      AND control.stage = 'apply'
      AND (control.state IN ('running', 'succeeded', 'needs_verification')
        OR (control.state = 'skipped' AND NOT (
            control.error_code IS 'DRY_RUN' AND control.retryable = 1)))
)
"""
APPLY_UNRESOLVED_SKIP_SQL = """
EXISTS (
    SELECT 1 FROM job_events stopped
    WHERE stopped.tenant_id = jobs.tenant_id AND stopped.job_id = jobs.job_id
      AND stopped.stage = 'apply' AND stopped.event_type = 'StageSkipped'
      AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,
                       '$.previousState') = 'needs_verification'
      AND NOT EXISTS (SELECT 1 FROM job_events resolved
        WHERE resolved.tenant_id = stopped.tenant_id AND resolved.job_id = stopped.job_id
          AND resolved.stage = 'apply' AND resolved.event_type = 'ApplicationManuallyMarked'
          AND resolved.event_id > stopped.event_id)
)
"""
APPLY_MANUAL_STOP_SQL = """
EXISTS (
    SELECT 1 FROM job_events stopped
    WHERE stopped.tenant_id = jobs.tenant_id AND stopped.job_id = jobs.job_id
      AND stopped.stage = 'apply' AND stopped.event_type = 'StageSkipped'
      AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,
                       '$.manualDisposition') = 'skip'
      AND NOT EXISTS (SELECT 1 FROM job_events released
        WHERE released.tenant_id = stopped.tenant_id AND released.job_id = stopped.job_id
          AND released.stage = 'apply'
          AND (released.event_type = 'ApplicationManuallyMarked' OR (
            released.event_type = 'StageReset'
            AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,
                             '$.resetAuthority') = 'explicit_safe_apply_reset'
            AND json_type(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,
                          '$.manualSkipReleasedThroughEventId') = 'integer'
            AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END, '$.manualSkipReleasedThroughEventId') >= stopped.event_id
            AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END, '$.manualSkipReleasedThroughEventId') < released.event_id))
          AND released.event_id > stopped.event_id)
)
"""
APPLY_ADMISSIBLE_SQL = (
    f"NOT ({APPLY_STOPPED_SQL}) AND NOT ({APPLY_SUBMIT_INTENT_SQL}) "
    f"AND NOT ({APPLY_UNRESOLVED_SKIP_SQL}) AND NOT ({APPLY_MANUAL_STOP_SQL})"
)


def assert_safe_apply_reset(conn, *, tenant_id, job_id):
    """Caller holds the writer; only a safe explicit reset releases a stop."""
    if not conn.in_transaction:
        raise RuntimeError("Apply reset requires a write transaction")
    uncertain = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_UNRESOLVED_SKIP_SQL})",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if uncertain:
        raise ValueError("Apply outcome still needs verification. Skip and reset do not resolve external uncertainty.")
    intent = conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? "
        "AND stage='apply' AND event_type='ApplySubmitIntended' LIMIT 1",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if intent:
        raise ValueError("Apply submission intent is recorded. Verify the external outcome; reset cannot authorize retry.")
    row = conn.execute(
        "SELECT state, error_code, retryable FROM job_stage_states "
        "WHERE tenant_id=? AND job_id=? AND stage='apply'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if has_unsettled_apply_run(conn, tenant_id=tenant_id, job_id=job_id):
        raise ValueError("Apply reset refused: the prior admitted run has no confirmed local settlement. Stop and verify that run first.")
    if row and (row[0] in {'queued', 'running', 'succeeded', 'needs_verification'} or (
        row[0] == 'skipped' and row[1] not in {None, 'DRY_RUN'}
    )):
        raise ValueError("Apply reset refused: active, applied or unresolved state requires explicit resolution.")


def has_unsettled_apply_run(conn, *, tenant_id, job_id):
    """A stage relabel cannot prove that its prior admitted owner stopped."""
    import json

    row = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        return False
    try:
        owner = json.loads(row[0] or '{}')
        run_id = owner.get('run_id')
    except (ValueError, TypeError, AttributeError):
        return True
    if not isinstance(run_id, str) or not run_id:
        return True
    terminal = conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type IN ('ApplicationSubmitted','ApplicationFailed','DryRunCompleted','ApplyManualSkip','LockReleased') "
        "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=? LIMIT 1",
        (str(tenant_id), str(job_id), run_id),
    ).fetchone()
    if terminal:
        return False
    return True


def explicit_apply_reset_payload(conn, *, tenant_id, job_id):
    """Bind this validated user reset to its existing Skip history under the writer.

    Automatic reconciliation also emits StageReset, but cannot release human
    stops. The event frontier cannot release any subsequent Skip.
    """
    assert_safe_apply_reset(conn, tenant_id=tenant_id, job_id=job_id)
    row = conn.execute(
        "SELECT MAX(event_id) FROM job_events WHERE tenant_id=? AND job_id=? "
        "AND stage='apply' AND event_type='StageSkipped' "
        "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,"
        "'$.manualDisposition')='skip'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    return {"resetAuthority": "explicit_safe_apply_reset", "manualSkipReleasedThroughEventId": row[0]}
