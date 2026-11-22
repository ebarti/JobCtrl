"""Receipt custody for newly admitted manual Fit qualification batches."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from jobctrl.app.errors import AppError

from .sources import fingerprint

RECEIPT_POLICY = "fit-manual-qualification-receipt-v1"
OPERATION = "fit.qualification-batch"


def _ambiguous():
    return AppError("fit_refresh_qualification_receipt_ambiguous", "An exact prior qualification receipt cannot be selected.", 409)


def _raw(receipt, authority, arguments):
    if receipt.get("status") != "succeeded":
        raise AppError("fit_refresh_qualification_receipt_unsettled", "The exact prior qualification has no settled success.", 409)
    if (not receipt.get("receipt_id") or not receipt.get("completed_at") or not isinstance(receipt.get("value"), dict)
            or receipt.get("input_fingerprint") != authority["input_fingerprint"]
            or any(receipt.get(key) != arguments[key] for key in ("operation", "lane", "prompt_version"))
            or any(receipt.get(key) != value for key, value in authority["selection"].items())):
        raise AppError("fit_model_provenance_invalid", "The stored qualification receipt belongs to another request.", 422)
    return {"value": receipt["value"], "provenance": {key: receipt[key] for key in (
        "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at")}}


def _legacy_receipt(model, previous, expected, exact, connection):
    # Fit stored microseconds; the gateway clock records the start of a UTC
    # millisecond. Include boundary buckets in the search and refuse uncertain
    # placement rather than assigning a neighbouring operation's paid receipt.
    opened = datetime.fromisoformat(previous["created_at"])
    closed = datetime.fromisoformat(previous["updated_at"])
    first = opened.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    last = closed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    window = model.receipt_ids_in_window(OPERATION, first, last, connection)
    if len(window) > 1:
        if len(exact) >= 64 or any(first <= row["created_at"] <= last for row in exact):
            raise _ambiguous()
        return None
    if not window:
        return None
    receipt = model.receipt(window[0], connection)
    if receipt["input_fingerprint"] != expected:
        return None
    if (datetime.fromisoformat(receipt["created_at"]) < opened or not receipt.get("completed_at")
            or datetime.fromisoformat(receipt["completed_at"]) + timedelta(milliseconds=1) > closed):
        raise _ambiguous()
    return receipt


async def determine(operation, model, arguments, key):
    state = operation.check()
    store, operation_id = operation.store, operation.operation_id
    prior = state["calls"].get(key)
    if prior is not None:
        if (prior.get("kind") != OPERATION or not prior.get("receipt_id") or not prior.get("selection")
                or not prior.get("execution") or not prior.get("input_fingerprint")
                or fingerprint({**arguments, **prior["selection"], "execution": prior["execution"]}) != prior["input_fingerprint"]):
            raise AppError("fit_refresh_interrupted", "The original qualification authority cannot be verified.", 409)
        receipt = model.receipt(prior["receipt_id"])
        if receipt.get("status") != "succeeded":
            raise AppError("fit_refresh_interrupted", "The original qualification has no settled receipt.", 409)
        raw = _raw(receipt, prior, arguments)
        if prior["status"] == "completed":
            if raw != prior["result"]:
                raise AppError("fit_model_provenance_invalid", "The stored qualification differs from its gateway receipt.", 422)
        else:
            operation.check()
            store.complete_refresh_call(operation_id, key, raw)
        return SimpleNamespace(**raw)

    execution = model.freeze_execution()
    expected = model.fingerprint(**arguments, execution=execution)
    authority = {"input_fingerprint": expected, "execution": execution.identity(),
                 "selection": {"provider": execution.provider, "model": execution.model}}
    prior_calls = store.unpublished_qualification_calls(state, key, expected)
    known_receipts = set()
    if prior_calls:
        def lookup(connection):
            exact = model.receipts_for(OPERATION, expected, connection)
            known_receipts.update(row["receipt_id"] for row in exact)
            if any(row["status"] in {"running", "uncertain"} for row in exact):
                raise AppError("fit_refresh_qualification_receipt_unsettled", "The earlier exact qualification remains unsettled.", 409)
            selected = {}
            for previous in prior_calls:
                if not previous["eligible"]:
                    continue
                if previous["receipt_id"]:
                    if previous["gateway_input"] != expected:
                        raise _ambiguous()
                    receipt = model.receipt(previous["receipt_id"], connection)
                else:
                    receipt = _legacy_receipt(model, previous, expected, exact, connection)
                    if receipt is None:
                        continue
                selected[receipt["receipt_id"]] = receipt
                if len(selected) > 1:
                    raise _ambiguous()
            if not selected:
                return None
            receipt = next(iter(selected.values()))
            return _raw(receipt, authority, arguments)

        # Look up and adopt the gateway result in the same short transaction.
        # Qualification.candidates still validates the entire source-bound decision.
        raw = store.adopt_refresh_qualification(operation_id, key, authority, lookup)
        if raw is not None:
            return SimpleNamespace(**raw)

    def admitted(connection, receipt_id):
        if operation.cancelled():
            raise asyncio.CancelledError()
        if prior_calls:
            observed = {row["receipt_id"] for row in model.receipts_for(OPERATION, expected, connection)}
            # The allocation rolls back if another exact attempt appeared since lookup.
            if observed != known_receipts | {receipt_id}:
                raise AppError("fit_refresh_qualification_receipt_ambiguous", "The exact qualification receipt changed before dispatch.", 409)
        store.reserve_refresh_call(operation_id, key, OPERATION, authority={**authority, "receipt_id": receipt_id}, connection=connection)

    remaining = (datetime.fromisoformat(state["deadline_at"]) - datetime.now(timezone.utc)).total_seconds()
    try:
        result = await asyncio.wait_for(model.determine(**arguments, execution=execution, on_admitted=admitted), timeout=remaining)
    except TimeoutError:
        raise AppError("fit_refresh_time_limit", "The manual Fit refresh reached its fixed deadline.", 409) from None
    operation.check()
    raw = _raw(model.receipt(result.provenance["receipt_id"]), authority, arguments)
    store.complete_refresh_call(operation_id, key, raw)
    return SimpleNamespace(**raw)
