"""Cross-job coordination for exact determinations in independently admitted Search jobs."""

import asyncio
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from .errors import AppError
from .model_custody import current_owner, may_replace_settled


SCHEMA = """
CREATE TABLE app_shared_model_work (
 binding_key TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES app_model_calls(receipt_id), validation_error TEXT
);
CREATE INDEX app_shared_model_work_receipt ON app_shared_model_work(receipt_id);
"""


def owned_validation_refusal(connection, owner_keys, operation, failure_code):
    rows = connection.execute(
        "SELECT c.receipt_id,c.prompt_version,s.binding_key FROM app_model_operation_receipts m "
        "JOIN app_model_calls c ON c.receipt_id=m.receipt_id AND c.operation=m.operation "
        "AND c.input_fingerprint=m.input_fingerprint JOIN app_shared_model_work s ON s.receipt_id=c.receipt_id "
        "WHERE m.owner_key=ANY(?::text[]) AND m.operation=? AND c.status='succeeded' AND s.validation_error=? LIMIT 2",
        (list(owner_keys), operation, failure_code),
    ).fetchall()
    return rows[0] if len(rows) == 1 else None


@asynccontextmanager
async def coordinate_work(database, keys, cancelled):
    """Hold only the named dependencies. Writers and independent provider calls remain free."""
    keys = sorted(set(keys))
    if not keys or current_owner() is None:
        yield False
        return
    while True:
        if cancelled():
            raise asyncio.CancelledError()
        connection = database.try_coordination_connection()
        if connection is not None:
            with connection:
                if all(connection.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended(?,0))", ("jobctrl.shared-work:" + key,)
                ).fetchone()[0] for key in keys):
                    yield True
                    return
        # Release the dedicated connection and any partial lock set before waiting.
        await asyncio.sleep(0.2)


@dataclass
class SharedReceipt:
    keys: tuple[str, ...]
    receipt_id: str | None = None
    validation_error: str | None = None

    def prior(self, connection, operation, digest):
        records = connection.execute(
            "SELECT DISTINCT c.receipt_id,c.operation,c.input_fingerprint,c.status,s.validation_error FROM app_shared_model_work s "
            "JOIN app_model_calls c ON c.receipt_id=s.receipt_id WHERE s.binding_key=ANY(?::text[]) "
            "ORDER BY c.receipt_id", (list(self.keys),),
        ).fetchall()
        if not records:
            return None
        row = records[0]
        compatible = len(records) == 1 and row["input_fingerprint"] == digest and row["operation"] == operation
        refused = row["status"] == "failed" or row["validation_error"] is not None
        if compatible and (not refused or not may_replace_settled()):
            return row
        if may_replace_settled() and all(item["status"] in {"succeeded", "failed"} for item in records):
            # A fresh, explicitly admitted owner may replace a known result
            # it cannot use. The original immutable receipt remains inspectable.
            connection.execute("DELETE FROM app_shared_model_work WHERE binding_key=ANY(?::text[])", (list(self.keys),))
            return None
        raise AppError("model_shared_publication_pending",
                       "A shared requirement is awaiting its original provider result or publication.", 409,
                       {"receiptId": row["receipt_id"]})

    def bind(self, connection, receipt_id):
        connection.execute(
            "INSERT INTO app_shared_model_work(binding_key,receipt_id) "
            "SELECT unnest(?::text[]),? ON CONFLICT(binding_key) DO NOTHING", (list(self.keys), receipt_id),
        )
        self.receipt_id = receipt_id

    def used(self, receipt_id):
        self.receipt_id = receipt_id

    def reject(self, error_code):
        self.validation_error = error_code


_receipt = ContextVar("model_shared_receipt", default=None)


def active_shared_receipt():
    return _receipt.get()


def reject_shared_result(receipt_id, error_code):
    work = active_shared_receipt()
    if work is not None:
        work.used(receipt_id)
        work.reject(error_code)


@contextmanager
def share_receipt(database, keys):
    """Reserve before dispatch. Release a known result only after its domain boundary returns."""
    if current_owner() is None or not keys:
        yield None
        return
    work = SharedReceipt(tuple(sorted(set(keys))))
    token = _receipt.set(work)
    published = False
    try:
        yield work
        published = True
    finally:
        _receipt.reset(token)
        if work.receipt_id and (published or work.validation_error):
            with database.transaction() as connection:
                if work.validation_error:
                    connection.execute(
                        "UPDATE app_shared_model_work s SET validation_error=? FROM app_model_calls c "
                        "WHERE s.binding_key=ANY(?::text[]) AND s.receipt_id=? AND c.receipt_id=s.receipt_id "
                        "AND c.status IN ('succeeded','failed')", (work.validation_error, list(work.keys), work.receipt_id),
                    )
                else:
                    connection.execute("DELETE FROM app_shared_model_work WHERE binding_key=ANY(?::text[]) AND receipt_id=?",
                                       (list(work.keys), work.receipt_id))
