"""Optional owner of one source-bound call per model operation in a durable stage."""

from contextlib import contextmanager
from contextvars import ContextVar

from jobctrl.app.errors import AppError

SCHEMA = """
CREATE TABLE app_model_operation_receipts (
 owner_key TEXT NOT NULL, operation TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE REFERENCES app_model_calls(receipt_id), PRIMARY KEY(owner_key,operation)
);
"""

_owner = ContextVar("model_call_owner", default=None)


@contextmanager
def model_call_scope(owner_key: str):
    if not isinstance(owner_key, str) or not owner_key:
        raise ValueError("Model custody requires a durable operation identity.")
    token = _owner.set(owner_key)
    try:
        yield
    finally:
        _owner.reset(token)


def current_owner():
    return _owner.get()


def assert_retryable_owners(owners, connection):
    if owners and connection.execute(
        "SELECT 1 FROM app_model_operation_receipts m JOIN app_model_calls c ON c.receipt_id=m.receipt_id "
        "WHERE m.owner_key=ANY(?::text[]) AND c.status IN ('running','uncertain') LIMIT 1", (list(owners),),
    ).fetchone():
        raise AppError("model_operation_unsettled", "The earlier provider call has an unresolved charge. Inspect it before retrying.", 409)
