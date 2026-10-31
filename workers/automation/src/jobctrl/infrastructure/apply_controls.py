"""Canonical local Apply controls, independent of lifecycle projections.

An intent is a permanent no-blind-retry boundary. Neither a failed result nor
an unrelated local stage label proves that the provider did not accept it.
"""


def valid_email_operation(operation, tenant_id, job_id, run_id):
    """Require the complete immutable operation identity used at admission."""
    from dataclasses import fields
    from jobctrl.domain.ports.apply import EmailApplicationOperation

    return (
        isinstance(operation, dict)
        and set(operation) == {field.name for field in fields(EmailApplicationOperation)}
        and all(isinstance(value, str) and bool(value.strip()) for value in operation.values())
        and operation["tenant_id"] == str(tenant_id) and operation["job_id"] == str(job_id)
        and operation["run_id"] == str(run_id) and operation["intent_id"] == f"email:{run_id}"
    )


def valid_email_confirmation(intent, receipt, tenant_id, job_id, run_id):
    """Verify a receipt against the exact previously admitted operation."""
    from jobctrl.domain.ports.apply import EmailApplicationOperation, EmailApplicationSendResult

    if (not isinstance(intent, dict) or not isinstance(receipt, dict) or intent.get("submission_channel") != "email"
            or intent.get("run_id") != str(run_id) or receipt.get("run_id") != str(run_id)):
        return False
    operation = receipt.get("operation")
    if not valid_email_operation(operation, tenant_id, job_id, run_id) or intent.get("operation") != operation:
        return False
    bound = EmailApplicationOperation(**operation)
    return EmailApplicationSendResult(
        provider=receipt.get("provider"), message_id=receipt.get("message_id"),
        thread_id=receipt.get("thread_id"), operation=bound,
    ).confirms(bound)


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
      AND stopped.stage = 'apply' AND ((stopped.event_type = 'StageSkipped'
        AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,
                         '$.previousState') = 'needs_verification')
        OR (stopped.event_type = 'ApplicationFailed'
        AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,
                         '$.result') = 'needs_verification'))
      AND NOT EXISTS (SELECT 1 FROM job_events resolved
        WHERE resolved.tenant_id = stopped.tenant_id AND resolved.job_id = stopped.job_id
          AND resolved.stage = 'apply' AND resolved.event_type = 'ApplicationManuallyMarked'
          AND resolved.event_id > stopped.event_id)
      AND NOT (stopped.event_type='ApplicationFailed'
        AND COALESCE(json_type(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id'),'')='text'
        AND length(json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id')) > 0
        AND EXISTS (SELECT 1 FROM job_events submitted WHERE submitted.tenant_id=stopped.tenant_id AND submitted.job_id=stopped.job_id
          AND submitted.stage='apply' AND submitted.event_type='ApplicationSubmitted' AND submitted.event_id > stopped.event_id
          AND json_extract(CASE WHEN json_valid(submitted.payload_json) THEN submitted.payload_json ELSE '{}' END,'$.run_id') =
            json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id')))
)
"""
APPLY_MANUAL_STOP_SQL = """
EXISTS (
    SELECT 1 FROM job_events stopped
    WHERE stopped.tenant_id = jobs.tenant_id AND stopped.job_id = jobs.job_id
      AND stopped.stage = 'apply' AND stopped.event_type = 'StageSkipped'
      AND (json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,
                       '$.manualDisposition') = 'skip'
        OR stopped.message = 'Job marked skipped from the local API.')
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
APPLY_RECORDED_APPLIED_SQL = """
EXISTS (
    SELECT 1 FROM job_events event WHERE event.tenant_id=jobs.tenant_id AND event.job_id=jobs.job_id AND event.stage='apply'
      AND (event.event_type IN ('ApplicationManuallyMarked','ApplicationSubmitted') OR
        (event.event_type='StageSkipped' AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.previousState')='succeeded'))
)
"""
APPLY_SKIPPED_QUEUED_SQL = """
EXISTS (
    SELECT 1 FROM job_events event WHERE event.tenant_id=jobs.tenant_id AND event.job_id=jobs.job_id AND event.stage='apply'
      AND event.event_type='StageSkipped'
      AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
      AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.previousState')='queued'
)
"""
# The older score producer wrote this complete structured event. A legacy
# manual Skip could contain any user-authored reason, so that field alone
# cannot establish score-policy authority.
_LEGACY_SCORE_POLICY_SQL = """
    COALESCE((policy.event_type='StageSkipped'
      AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.reason')='score_below_threshold'
      AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.upstreamStage')='score'
      AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.downstreamStage')='apply'
      AND json_type(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.fitScore')='integer'
      AND json_type(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.minScore')='integer'
      AND policy.message='Fit score ' || CAST(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.fitScore') AS TEXT)
        || '/10 is below the materials threshold ' || CAST(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.minScore') AS TEXT) || '/10.'), 0)
"""
APPLY_RETAINED_POLICY_SKIP_SQL = """
EXISTS (
    SELECT 1 FROM job_events policy WHERE policy.tenant_id=jobs.tenant_id AND policy.job_id=jobs.job_id AND policy.stage='apply'
      AND (
        (policy.event_type='StageSkipped'
          AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
          AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousState')='skipped'
          AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode') IS NOT NULL
          AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode') <> 'DRY_RUN')
        OR ((policy.event_type='ApplyManualSkip' AND policy.message='manual ATS') OR {_LEGACY_SCORE_POLICY_SQL})
          AND EXISTS (SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=policy.tenant_id AND stopped.job_id=policy.job_id
            AND stopped.stage='apply' AND stopped.event_type='StageSkipped' AND stopped.event_id > policy.event_id
            AND ((json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
              AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.previousState')='skipped')
              OR stopped.message='Job marked skipped from the local API.'))
      )
      AND NOT (({_LEGACY_SCORE_POLICY_SQL}
            OR COALESCE(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode'),'')='MIN_SCORE')
        AND EXISTS (SELECT 1 FROM job_events cleared WHERE cleared.tenant_id=policy.tenant_id AND cleared.job_id=policy.job_id
          AND cleared.stage='apply' AND cleared.event_type='StageReset' AND cleared.event_id > policy.event_id
          AND cleared.message='apply restored after the score threshold allowed materials.'
          AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.reason')='score_threshold_cleared'
          AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.upstreamStage')='score'
          AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.downstreamStage')='apply'))
)
""".replace("{_LEGACY_SCORE_POLICY_SQL}", _LEGACY_SCORE_POLICY_SQL)
APPLY_ADMISSIBLE_SQL = (
    f"NOT ({APPLY_STOPPED_SQL}) AND NOT ({APPLY_SUBMIT_INTENT_SQL}) "
    f"AND NOT ({APPLY_UNRESOLVED_SKIP_SQL}) AND NOT ({APPLY_MANUAL_STOP_SQL}) "
    f"AND NOT ({APPLY_RECORDED_APPLIED_SQL}) AND NOT ({APPLY_SKIPPED_QUEUED_SQL}) AND NOT ({APPLY_RETAINED_POLICY_SKIP_SQL})"
)
_APPLY_STOPPED_FOR_OWNER_RECOVERY_SQL = APPLY_STOPPED_SQL.replace(
    "('running', 'succeeded', 'needs_verification')", "('succeeded', 'needs_verification')"
)
APPLY_ADMISSIBLE_FOR_OWNER_RECOVERY_SQL = (
    f"NOT ({_APPLY_STOPPED_FOR_OWNER_RECOVERY_SQL}) "
    f"AND NOT ({APPLY_SUBMIT_INTENT_SQL}) AND NOT ({APPLY_UNRESOLVED_SKIP_SQL}) AND NOT ({APPLY_MANUAL_STOP_SQL}) "
    f"AND NOT ({APPLY_RECORDED_APPLIED_SQL}) AND NOT ({APPLY_SKIPPED_QUEUED_SQL}) AND NOT ({APPLY_RETAINED_POLICY_SKIP_SQL})"
)


def capture_apply_dispatch_frontier(conn, *, tenant_id, job_id=None):
    """Serialize a dispatch snapshot against Skip/reset writers without committing a caller's transaction."""
    owned = not conn.in_transaction
    if owned:
        conn.execute('BEGIN IMMEDIATE')
    else:
        # Upgrade a caller-owned transaction to a writer before observing the frontier.
        conn.execute('UPDATE job_stage_states SET state=state WHERE 0')
    try:
        frontier = conn.execute('SELECT COALESCE(MAX(event_id),0) FROM job_events WHERE tenant_id=?',
                                (str(tenant_id),)).fetchone()[0]
        reset_generation = 0
        if job_id is not None:
            reset_generation = conn.execute(
                "SELECT COALESCE(MAX(event_id),0) FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
                "AND event_type='StageReset' "
                "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.resetAuthority')='explicit_safe_apply_reset' "
                "AND json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.manualSkipReleasedThroughEventId')='integer'",
                (str(tenant_id), str(job_id)),
            ).fetchone()[0]
        if owned:
            conn.commit()
        return int(frontier), int(reset_generation)
    except BaseException:
        if owned:
            conn.rollback()
        raise


def apply_dispatch_allows(conn, *, tenant_id, job_id, frontier):
    """A later Skip or its explicit release cannot authorize an older dispatch."""
    if frontier is not None and (type(frontier) is not int or frontier < 0):
        return False
    # The historical API wrote this exact top-level message on its apply-stage
    # StageSkipped event. User-provided reason text lived only in the payload;
    # never search or interpret that prose. Missing frontiers fence only the
    # affected job, not the rest of a legacy batch.
    observed = 0 if frontier is None else frontier
    return conn.execute(
        "SELECT 1 FROM job_events event WHERE event.tenant_id=? AND event.job_id=? AND event.stage='apply' "
        "AND event.event_id > ? AND ("
        "(event.event_type='StageSkipped' AND ("
        "json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.manualDisposition')='skip' "
        "OR event.message='Job marked skipped from the local API.')) OR "
        "(event.event_type='StageReset' AND "
        "json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.resetAuthority')='explicit_safe_apply_reset' "
        "AND json_type(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.manualSkipReleasedThroughEventId')='integer')) LIMIT 1",
        (str(tenant_id), str(job_id), observed),
    ).fetchone() is None


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
    for expression, reason in (
        (APPLY_RECORDED_APPLIED_SQL, "an applied outcome is recorded"),
        (APPLY_SKIPPED_QUEUED_SQL, "queued work was skipped without a confirmed settlement"),
        (APPLY_RETAINED_POLICY_SKIP_SQL, "the prior policy-owned skip remains in effect"),
    ):
        if conn.execute(
            f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({expression})",
            (str(tenant_id), str(job_id)),
        ).fetchone():
            raise ValueError(f"Apply reset refused: {reason}.")
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
        "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        return conn.execute(
            "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type='ApplyClaimAcquired' LIMIT 1", (str(tenant_id), str(job_id)),
        ).fetchone() is not None
    try:
        owner = json.loads(row[1] or '{}')
        run_id = owner.get('run_id')
    except (ValueError, TypeError, AttributeError):
        return True
    if not isinstance(run_id, str) or not run_id:
        return True
    claim = conn.execute(
        "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyClaimAcquired' ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if claim:
        try:
            claim_payload = json.loads(claim[1] or '{}')
        except (ValueError, TypeError):
            return True
        if not isinstance(claim_payload, dict) or claim_payload.get('run_id') != run_id:
            return True
        launcher_id = claim_payload.get('launcher_id')
        if launcher_id is not None:
            if not isinstance(launcher_id, str) or not launcher_id:
                return True
            return conn.execute(
                "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
                "AND event_id > ? AND event_type IN ('ApplyClaimSettled','ApplyCustodyRetired') "
                "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=? "
                "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.launcher_id')=? LIMIT 1",
                (str(tenant_id), str(job_id), claim[0], run_id, launcher_id),
            ).fetchone() is None
    terminal = conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type IN ('ApplicationSubmitted','ApplicationFailed','DryRunCompleted','ApplyManualSkip','ApplyCustodyRetired') "
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
        "AND (json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,"
        "'$.manualDisposition')='skip' OR message='Job marked skipped from the local API.')",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    return {"resetAuthority": "explicit_safe_apply_reset", "manualSkipReleasedThroughEventId": row[0]}
