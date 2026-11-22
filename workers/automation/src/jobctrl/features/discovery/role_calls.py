"""Receipt ownership for each paid role-target check, before external dispatch."""

from jobctrl.app.errors import AppError

ROLE_CALL_CUSTODY = "atomic-role-receipt-v1"


class _RecordedCall(Exception):
    def __init__(self, receipt):
        self.receipt = receipt


def _retained(model, prior, expected, connection=None):
    if prior["input_fingerprint"] != expected:
        raise AppError("discovery_role_input_changed", "The posting or model changed after this role check started.", 409)
    receipt = model.receipt(prior["receipt_id"], connection)
    if receipt["status"] in {"running", "uncertain"}:
        raise AppError("discovery_role_call_unsettled", "The earlier role check has no confirmed provider outcome.", 409)
    if receipt["status"] != "succeeded":
        raise AppError(receipt.get("error_code") or "discovery_role_call_failed", "The recorded role check failed.", 502)
    return receipt


async def dispatch_role_call(model, store, owner, request, expected, validate, guard, *, legacy_recovery=False):
    prior = store.role_call(owner)
    if prior is not None:
        return _retained(model, prior, expected)

    def reusable(connection=None, own_receipt=None):
        # Old frozen runs may have gateway receipts predating feature custody.
        # Exact successful authority can be reused. A lost remote outcome
        # cannot be redispatched through another query, source or worker.
        for receipt in model.receipts_for(request["operation"], expected, connection):
            if receipt["receipt_id"] == own_receipt:
                continue
            if receipt["status"] in {"running", "uncertain"}:
                raise AppError("discovery_role_call_unsettled", "An existing role check has no confirmed provider outcome.", 409)
            if receipt["status"] == "succeeded":
                try:
                    validate(receipt["value"])
                except AppError:
                    continue  # A new explicit operation can make its own assessment.
                return receipt
        return None

    settled = reusable()
    if settled is not None:
        return settled
    if legacy_recovery:
        raise AppError("discovery_role_call_unowned",
                       "This older interrupted search cannot establish the earlier role check. Start a new search for remaining listings.", 409)

    def admitted(connection, receipt_id):
        # This callback and the model ledger's admission share one transaction.
        # Raising here rolls back the new ledger row before any provider I/O.
        guard(connection)
        prior = store.role_call(owner, connection)
        if prior is not None:
            raise _RecordedCall(_retained(model, prior, expected, connection))
        settled = reusable(connection, receipt_id)
        if settled is not None:
            raise _RecordedCall(settled)
        store.bind_role_call(owner, expected, receipt_id, connection)

    try:
        result = await model.determine(**request, on_admitted=admitted)
    except _RecordedCall as previous:
        return previous.receipt
    return model.receipt(result.provenance["receipt_id"])
